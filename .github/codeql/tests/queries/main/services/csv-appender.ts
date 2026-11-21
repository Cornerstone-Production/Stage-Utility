// One network read, written to a file four ways. The alerts are the two that do not
// pass through main/services/csv.ts's encodeRow, which proves the fixture can alert
// at all and that the barrier is that function alone.
//
// The sink is a write stream rather than the fs.appendFile the appender calls: a
// test database carries no definition of fs.appendFile's parameters, so CodeQL
// finds no data argument to it there, and the fixture would alert on nothing.
import * as fs from "fs";
import * as http from "http";

import { encodeRow } from "./csv.js";
import { encodeRow as lookalike } from "./lookalike.js";

export function record(url: string): void {
  const out = fs.createWriteStream("out.csv", { flags: "a" });
  http.get(url, (res) => {
    res.on("data", (chunk: string) => {
      out.write(chunk);
      out.write(lookalike([chunk]));
      out.write(encodeRow([chunk]));
      out.write(encodeRow(["at", chunk]));
    });
  });
}
