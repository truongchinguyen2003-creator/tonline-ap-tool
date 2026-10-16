"use strict";

const config = require("./configs/config1.js");
process.env.CAPSOLVER_KEY = config.CAPSOLVER.enabled
  ? config.CAPSOLVER.apiKey
  : "";

const { runMain } = require("./lib/runner");
runMain(config).catch((e) => console.error(`Fatal: ${e.message}`));
