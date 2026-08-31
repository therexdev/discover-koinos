/* Markdown → HTML for chat answers.
 *
 * These answers are generated on a volunteer's machine somewhere on the
 * Koinos AI network. That makes them UNTRUSTED text, so the order here is not
 * negotiable: escape everything first, then re-introduce a fixed, small set
 * of tags we chose. Nothing the model emits can become markup we did not
 * write — the worst it can do is show you angle brackets.
 *
 * Deliberately not a full markdown implementation. It covers what a chat
 * answer actually uses — bold, italic, inline code, fenced code, links,
 * bullet and numbered lists, headings, blockquotes, paragraphs — and leaves
 * anything else as the plain text it is.
 *
 * Loaded by the page as a plain script and by the selftest via require.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KaiMd = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return ESCAPES[c]; });
  }

  /* Inline spans, over text that is ALREADY escaped.
     Split on code spans rather than stashing them behind placeholders: a
     placeholder is a string the model could also emit, and then it would be
     substituted back as markup. Splitting cannot be spoofed — a segment
     either is a code span or it is not. */
  function inline(escaped) {
    return String(escaped).split(/(`[^`\n]+`)/).map(function (part) {
      if (part.length > 1 && part.charAt(0) === '`' && part.charAt(part.length - 1) === '`') {
        return '<code>' + part.slice(1, -1) + '</code>';
      }
      var s = part;
      /* Links: http(s) only. The URL comes out of already-escaped text, so
         there is no scheme a caller could smuggle in and no quote that could
         break the attribute. Every link leaves the page with noopener. */
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, label, url) {
        return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      });
      s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, function (m, pre, url) {
        return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
      });
      s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/__([^\n]+?)__/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');
      s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, '$1<em>$2</em>');
      return s;
    }).join('');
  }

  var LIST_ITEM = /^\s{0,3}([-*+])\s+(.*)$/;
  var ORDERED_ITEM = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
  var HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
  var QUOTE = /^\s{0,3}>\s?(.*)$/;
  var FENCE = /^\s{0,3}```/;

  function render(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var para = [];
    var list = null; // { tag, items: [[line, ...]] }

    function block(chunk) {
      return inline(esc(chunk.join('\n'))).replace(/\n/g, '<br>');
    }
    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + block(para) + '</p>');
      para = [];
    }
    function flushList() {
      if (!list) return;
      var items = list.items.map(function (chunk) { return '<li>' + block(chunk) + '</li>'; });
      out.push('<' + list.tag + '>' + items.join('') + '</' + list.tag + '>');
      list = null;
    }
    function flushAll() { flushPara(); flushList(); }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Fenced code: literal until the closing fence, or the end of a stream
      // that has not produced one yet.
      if (FENCE.test(line)) {
        flushAll();
        var body = [];
        for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
        out.push('<pre><code>' + esc(body.join('\n')) + '</code></pre>');
        continue;
      }

      if (!line.trim()) { flushAll(); continue; }

      var heading = HEADING.exec(line);
      if (heading) {
        flushAll();
        // h1 inside a chat bubble is shouting; start at h3.
        var level = Math.min(heading[1].length + 2, 6);
        out.push('<h' + level + '>' + inline(esc(heading[2])) + '</h' + level + '>');
        continue;
      }

      var quote = QUOTE.exec(line);
      if (quote) {
        flushAll();
        out.push('<blockquote>' + inline(esc(quote[1])) + '</blockquote>');
        continue;
      }

      var ul = LIST_ITEM.exec(line);
      var ol = ul ? null : ORDERED_ITEM.exec(line);
      if (ul || ol) {
        flushPara();
        var tag = ul ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag: tag, items: [] };
        list.items.push([ul ? ul[2] : ol[2]]);
        continue;
      }

      // A plain line after a list item is that item's wrapped text.
      if (list) { list.items[list.items.length - 1].push(line.trim()); continue; }

      para.push(line);
    }
    flushAll();
    return out.join('');
  }

  return { render: render, escapeHtml: esc };
});
