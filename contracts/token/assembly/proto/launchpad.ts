import { Writer, Reader } from "as-proto";

export namespace launchpad {
  export class config {
    static encode(message: config, writer: Writer): void {
      const unique_name_name = message.name;
      if (unique_name_name !== null) {
        writer.uint32(10);
        writer.string(unique_name_name);
      }

      const unique_name_symbol = message.symbol;
      if (unique_name_symbol !== null) {
        writer.uint32(18);
        writer.string(unique_name_symbol);
      }

      if (message.decimals != 0) {
        writer.uint32(24);
        writer.uint32(message.decimals);
      }

      if (message.mintable != false) {
        writer.uint32(32);
        writer.bool(message.mintable);
      }

      if (message.initialized != false) {
        writer.uint32(40);
        writer.bool(message.initialized);
      }
    }

    static decode(reader: Reader, length: i32): config {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new config();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.name = reader.string();
            break;

          case 2:
            message.symbol = reader.string();
            break;

          case 3:
            message.decimals = reader.uint32();
            break;

          case 4:
            message.mintable = reader.bool();
            break;

          case 5:
            message.initialized = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    name: string | null;
    symbol: string | null;
    decimals: u32;
    mintable: bool;
    initialized: bool;

    constructor(
      name: string | null = null,
      symbol: string | null = null,
      decimals: u32 = 0,
      mintable: bool = false,
      initialized: bool = false
    ) {
      this.name = name;
      this.symbol = symbol;
      this.decimals = decimals;
      this.mintable = mintable;
      this.initialized = initialized;
    }
  }

  export class initialize_args {
    static encode(message: initialize_args, writer: Writer): void {
      const unique_name_name = message.name;
      if (unique_name_name !== null) {
        writer.uint32(10);
        writer.string(unique_name_name);
      }

      const unique_name_symbol = message.symbol;
      if (unique_name_symbol !== null) {
        writer.uint32(18);
        writer.string(unique_name_symbol);
      }

      if (message.decimals != 0) {
        writer.uint32(24);
        writer.uint32(message.decimals);
      }

      if (message.initial_supply != 0) {
        writer.uint32(32);
        writer.uint64(message.initial_supply);
      }

      if (message.mintable != false) {
        writer.uint32(40);
        writer.bool(message.mintable);
      }

      const unique_name_owner = message.owner;
      if (unique_name_owner !== null) {
        writer.uint32(50);
        writer.bytes(unique_name_owner);
      }
    }

    static decode(reader: Reader, length: i32): initialize_args {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new initialize_args();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.name = reader.string();
            break;

          case 2:
            message.symbol = reader.string();
            break;

          case 3:
            message.decimals = reader.uint32();
            break;

          case 4:
            message.initial_supply = reader.uint64();
            break;

          case 5:
            message.mintable = reader.bool();
            break;

          case 6:
            message.owner = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    name: string | null;
    symbol: string | null;
    decimals: u32;
    initial_supply: u64;
    mintable: bool;
    owner: Uint8Array | null;

    constructor(
      name: string | null = null,
      symbol: string | null = null,
      decimals: u32 = 0,
      initial_supply: u64 = 0,
      mintable: bool = false,
      owner: Uint8Array | null = null
    ) {
      this.name = name;
      this.symbol = symbol;
      this.decimals = decimals;
      this.initial_supply = initial_supply;
      this.mintable = mintable;
      this.owner = owner;
    }
  }

  export class initialized_event {
    static encode(message: initialized_event, writer: Writer): void {
      const unique_name_name = message.name;
      if (unique_name_name !== null) {
        writer.uint32(10);
        writer.string(unique_name_name);
      }

      const unique_name_symbol = message.symbol;
      if (unique_name_symbol !== null) {
        writer.uint32(18);
        writer.string(unique_name_symbol);
      }

      if (message.decimals != 0) {
        writer.uint32(24);
        writer.uint32(message.decimals);
      }

      if (message.initial_supply != 0) {
        writer.uint32(32);
        writer.uint64(message.initial_supply);
      }

      const unique_name_owner = message.owner;
      if (unique_name_owner !== null) {
        writer.uint32(42);
        writer.bytes(unique_name_owner);
      }
    }

    static decode(reader: Reader, length: i32): initialized_event {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new initialized_event();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.name = reader.string();
            break;

          case 2:
            message.symbol = reader.string();
            break;

          case 3:
            message.decimals = reader.uint32();
            break;

          case 4:
            message.initial_supply = reader.uint64();
            break;

          case 5:
            message.owner = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    name: string | null;
    symbol: string | null;
    decimals: u32;
    initial_supply: u64;
    owner: Uint8Array | null;

    constructor(
      name: string | null = null,
      symbol: string | null = null,
      decimals: u32 = 0,
      initial_supply: u64 = 0,
      owner: Uint8Array | null = null
    ) {
      this.name = name;
      this.symbol = symbol;
      this.decimals = decimals;
      this.initial_supply = initial_supply;
      this.owner = owner;
    }
  }

  export class transfer_ownership_args {
    static encode(message: transfer_ownership_args, writer: Writer): void {
      const unique_name_to = message.to;
      if (unique_name_to !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_to);
      }
    }

    static decode(reader: Reader, length: i32): transfer_ownership_args {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new transfer_ownership_args();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.to = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    to: Uint8Array | null;

    constructor(to: Uint8Array | null = null) {
      this.to = to;
    }
  }
}
