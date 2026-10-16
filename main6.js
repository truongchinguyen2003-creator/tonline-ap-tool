"use strict";
const config = require("./configs/config6.js");
const { runMain } = require("./lib/runner");
runMain(config).catch((e) => console.error(`Fatal: ${e.message}`));
