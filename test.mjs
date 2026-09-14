import assert from "node:assert/strict";
import { keccak256 } from "./holder-verification.mjs";

const vectors = [
  ["", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ["hello", "1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8"],
];

for (const [message, expected] of vectors) {
  assert.equal(keccak256(Buffer.from(message)).toString("hex"), expected);
}

console.log("Ethereum Keccak test vectors: OK");
