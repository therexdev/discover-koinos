// SPDX-License-Identifier: MIT
// A token anyone can launch from the Discover Koinos gateway.
//
// This is Julian Gonzalez's audited Token contract from @koinosbox/contracts
// — the same KCS-4 implementation behind KOIN itself in spirit — with one
// change: the token's IDENTITY moves from compile time into state.
//
// The base contract declares name, symbol and decimals as class fields, so
// a token called anything else is a different binary. A launchpad cannot
// compile a contract per creator, so instead `initialize` writes those
// values once, and name()/symbol()/decimals()/get_info() read them back.
// One reviewed binary then serves every token ever launched, and holders
// can check that every gateway token runs identical code.
//
// Setup is authorized by the token's OWN account, which only exists during
// deployment, and is closed permanently by the `initialized` flag the
// first time it succeeds. A second call cannot rename a token people
// already hold balances of.

import { System, Storage, Protobuf } from "@koinos/sdk-as";
import { Token, token, common } from "@koinosbox/contracts";
import { launchpad } from "./proto/launchpad";

// Base Token uses spaces 0-2 (supply/balances/allowances); keep far away
// so an in-place upgrade never collides with live state.
const CONFIG_SPACE_ID = 500;
const OWNER_SPACE_ID = 501;

// KOIN itself uses 8; anything past 12 only manufactures dust.
const MAX_DECIMALS: u32 = 12;

export class LaunchpadToken extends Token {
  // Fallbacks only: a deployed-but-not-yet-initialized contract still
  // answers the KCS-4 reads rather than trapping.
  _name: string = "Uninitialized token";
  _symbol: string = "NONE";
  _decimals: u32 = 8;

  config: Storage.Obj<launchpad.config> = new Storage.Obj(
    this.contractId,
    CONFIG_SPACE_ID,
    launchpad.config.decode,
    launchpad.config.encode,
    () => new launchpad.config("", "", 0, false, false)
  );

  tokenOwner: Storage.Obj<common.address> = new Storage.Obj(
    this.contractId,
    OWNER_SPACE_ID,
    common.address.decode,
    common.address.encode,
    () => new common.address(new Uint8Array(0))
  );

  /**
   * Get the name of the token
   * @external
   * @readonly
   */
  name(): token.str {
    const c = this.config.get()!;
    return new token.str(c.initialized ? c.name! : this._name);
  }

  /**
   * Get the symbol of the token
   * @external
   * @readonly
   */
  symbol(): token.str {
    const c = this.config.get()!;
    return new token.str(c.initialized ? c.symbol! : this._symbol);
  }

  /**
   * Get the decimals of the token
   * @external
   * @readonly
   */
  decimals(): token.uint32 {
    const c = this.config.get()!;
    return new token.uint32(c.initialized ? c.decimals : this._decimals);
  }

  /**
   * Get name, symbol and decimals
   * @external
   * @readonly
   */
  get_info(): token.info {
    const c = this.config.get()!;
    if (!c.initialized)
      return new token.info(this._name, this._symbol, this._decimals, "");
    return new token.info(c.name!, c.symbol!, c.decimals, "");
  }

  /**
   * Who owns this token (mints and ownership transfers)
   * @external
   * @readonly
   */
  owner(): common.address {
    return this.tokenOwner.get()!;
  }

  /**
   * Get the launch configuration (identity + mintability)
   * @external
   * @readonly
   */
  get_config(): launchpad.config {
    return this.config.get()!;
  }

  /**
   * Mint new tokens. Only if the token was launched as mintable, and only
   * for its owner.
   * @external
   * @event token.mint_event token.mint_args
   */
  mint(args: token.mint_args): void {
    const c = this.config.get()!;
    System.require(c.initialized, "this token has not been set up yet");
    System.require(c.mintable, "this token was launched with a fixed supply");
    /* Owner OR the token's own account. The gateway keeps the token
       account's key as the upgrade authority — already strictly stronger
       than mint rights — and this is what lets a FREE mint happen with no
       wallet signature: the gateway signs as the token, on the owner's
       instruction, and the coins still land where the owner said.
       External wallets keep the plain owner path. */
    const authorized =
      System.checkAccountAuthority(this.tokenOwner.get()!.value!) ||
      System.checkAccountAuthority(this.contractId);
    System.require(authorized, "mint not authorized");
    this._mint(args);
  }

  /**
   * Burn tokens. Authorized exactly like a transfer: the holder's
   * signature, or an allowance they granted.
   * @external
   * @event token.burn_event token.burn_args
   */
  burn(args: token.burn_args): void {
    const isAuthorized = this.check_authority(args.from!, args.value);
    System.require(isAuthorized, "from has not authorized burn");
    this._burn(args);
  }

  /**
   * Hand the token to a new owner (mints and future ownership transfers).
   * @external
   */
  transfer_ownership(args: launchpad.transfer_ownership_args): void {
    const c = this.config.get()!;
    System.require(c.initialized, "this token has not been set up yet");
    const to = args.to === null ? new Uint8Array(0) : args.to!;
    System.require(to.length > 0, "a new owner is required");
    const authorized =
      System.checkAccountAuthority(this.tokenOwner.get()!.value!) ||
      System.checkAccountAuthority(this.contractId);
    System.require(authorized, "transfer_ownership not authorized");
    this.tokenOwner.put(new common.address(to));
  }

  /**
   * Name the token, set its supply and hand it to its creator.
   * Callable exactly once, by the token account itself.
   * @external
   * @event launchpad.initialized launchpad.initialized_event
   */
  initialize(args: launchpad.initialize_args): void {
    const c = this.config.get()!;
    System.require(!c.initialized, "this token has already been set up");

    // Only the contract account can perform setup, and that key exists
    // solely for deployment.
    System.require(
      System.checkAccountAuthority(this.contractId),
      "the token account must authorize its own setup"
    );

    /* Protobuf omits empty/zero values, so a token launched with, say,
       0 decimals arrives here with those fields ABSENT — strings decode
       as null, and dereferencing one traps the module with only "module
       exited due to trap" as diagnostics. Normalize first, validate
       second. */
    const name = args.name === null ? "" : args.name!;
    const symbol = args.symbol === null ? "" : args.symbol!;
    const owner = args.owner === null ? new Uint8Array(0) : args.owner!;

    System.require(name.length > 0 && name.length <= 64, "name must be 1-64 characters");
    System.require(symbol.length > 0 && symbol.length <= 16, "symbol must be 1-16 characters");
    System.require(args.decimals <= MAX_DECIMALS, "decimals cannot exceed 12");
    System.require(owner.length > 0, "an owner is required");
    System.require(
      args.initial_supply > 0 || args.mintable,
      "a fixed-supply token needs an initial supply"
    );

    c.name = name;
    c.symbol = symbol;
    c.decimals = args.decimals;
    c.mintable = args.mintable;
    c.initialized = true;
    this.config.put(c);

    // The creator owns it from here: mints (if mintable) and any later
    // transfer of ownership are all theirs.
    this.tokenOwner.put(new common.address(owner));

    if (args.initial_supply > 0) {
      this._mint(new token.mint_args(owner, args.initial_supply));
    }

    System.event(
      "launchpad.initialized",
      Protobuf.encode<launchpad.initialized_event>(
        new launchpad.initialized_event(
          name,
          symbol,
          args.decimals,
          args.initial_supply,
          owner
        ),
        launchpad.initialized_event.encode
      ),
      [owner]
    );
  }
}
