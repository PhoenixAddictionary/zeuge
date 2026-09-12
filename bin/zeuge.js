#!/usr/bin/env node
"use strict";

const { main } = require("../dist/cli.js");

const result = main(process.argv);
if (result && typeof result.then === "function") {
  result.then((code) => {
    process.exitCode = code;
  });
} else {
  process.exitCode = result;
}
