"use strict";
const config = require("./configs/config5.js");
const { runMain } = require("./lib/runner");
runMain(config).catch((e) => console.error(`Fatal: ${e.message}`));
