// The trade-off, on record. HttpToFileAccess checks the data written, not the path. Here
// the PATH comes from the network and the content is passed through encodeRow, and the
// query reports nothing: the barrier covers the data, and js/path-injection does not
// take a network response as a source. Nothing in the product does this; if something
// starts to, no query will say so.
import * as fs from "fs";
import * as http from "http";

import { encodeRow } from "./csv.js";
import { encodeRow as nearby } from "./archive/rows.js";

export function recordToNetworkPath(url: string): void {
  http.get(url, (res) => {
    res.on("data", (chunk: string) => {
      fs.createWriteStream(chunk).write(encodeRow(["x"]));
      fs.createWriteStream("out.csv").write(nearby([chunk]));
    });
  });
}
