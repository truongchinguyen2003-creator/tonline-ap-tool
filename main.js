"use strict";

const config = require("./configs/config.js");

// Set CapSolver key từ config
process.env.CAPSOLVER_KEY = config.CAPSOLVER.apiKey;

const { runMain } = require("./lib/runner");

runMain(config).catch((e) => console.error(`Fatal: ${e.message}`));
