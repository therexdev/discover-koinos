module.exports = {
  class: "LaunchpadToken",
  version: "1.0.0",
  supportAbi1: true,
  proto: ["./proto/launchpad.proto"],
  files: ["./LaunchpadToken.ts"],
  sourceDir: "./assembly",
  buildDir: "./build",
  // Pull in the audited base contract so its entry points (transfer,
  // approve, allowance, balance_of, total_supply …) land in this ABI too.
  filesImport: [
    {
      dependency: "@koinosbox/contracts",
      path: "../node_modules/@koinosbox/contracts/assembly/token/Token.ts",
    },
  ],
  protoImport: [
    {
      name: "@koinosbox/contracts",
      path: "../node_modules/@koinosbox/contracts/koinosbox-proto",
      exclude: ["vapor"],
    },
    {
      name: "@koinos/sdk-as",
      path: "../node_modules/koinos-precompiler-as/koinos-proto/koinos",
    },
    {
      name: "__",
      path: "../node_modules/koinos-precompiler-as/koinos-proto/google",
    },
  ],
  deployOptions: {},
};
