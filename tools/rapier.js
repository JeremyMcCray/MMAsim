// Resolves the Rapier physics engine for the node tools from the game's own browser build:
// lib/rapier3d-compat.js is the CommonJS dist wrapped to assign window.RAPIER, so unwrap it and
// compile the inner module (evaluating the wrapper as-is makes the WASM trap in node).
const fs = require('fs');
const path = require('path');
const Module = require('module');
const file = path.join(__dirname, '..', 'lib', 'rapier3d-compat.js');
const src = fs.readFileSync(file, 'utf8');
const m = new Module(file, module);
m._compile(src.slice(src.indexOf('"use strict"'), src.lastIndexOf(';window.RAPIER')), file);
module.exports = m.exports;
