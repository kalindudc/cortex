import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { WORKSTREAM_MIGRATIONS } from "./workstream-store";

// Statement hashes bb recorded for the migrations released in 0.109.0. bb refuses to load the plugin when a
// recorded index changes, so new migrations go after these and these never change.
const SHIPPED = [
  "69c8250eaeec3ee8bda834851848d13bb2fe6c123f37087876b70c88df9260de",
  "3ae7fbb3ab697a7ca6f24cfdcd8b25f75b56c63a052d6eaf2cc12154bcddfbb2",
  "185de9e4521f1d4024e0b9b0249d5b945cb6d2c4f961f0143871d132a2b74a91",
  "9100ffc63338cee6c3859b467f29fdf3de67a9d3a8e8b57d17838d7625c0499a",
  "c4c9f1bc3a79422a24e331d434b3be41497fe84e60d7387421a44c00206544d6",
  "af927e237100cf33e216c79f1ab1c9f6f1744e00bcd1a330f65241ab39a3dd65",
  "9b1cd6f185b83b827f3a2bdd28d0542fb282f491dae08c99b88800dc206826b5",
  "4ea1781e20d4dd7fd9111d88634ea96f837c2526ad71b1d99c01c554c1336876",
  "d23203e91474b54d79fa39c5f48dc670ef50b499663ce3594180e940496bc71d",
  "3808756747c8a91c0757aafc67fd6f0400812bff1a3b8c8bc75a00da1a7aaa58",
  "9a4860454a0d3299473b66b21c1ae2692f0eb0cd0fb7793ca853c386f58d6e9c",
  "00a7574468f718612de6f9468bf11dba984767e993505f505e15d0c39d3eee54",
  "fe832f97f0a7c61d01e7467809c4ff8c44b486f5028433378e72a782c096e7bc",
  "e27ecd8c384b8902374aae7033b7ad0b1e745de451015af8f426baecb283fdfd",
  "aa9242bea7761bd7800d35df9f95dc45ccc54101124ea6da8da5c9931db0a143",
];

test("shipped plugin migrations keep their positions; new ones are appended", () => {
  const hashes = WORKSTREAM_MIGRATIONS.map(statement => createHash("sha256").update(statement).digest("hex"));
  expect(hashes.slice(0, SHIPPED.length)).toEqual(SHIPPED);
});
