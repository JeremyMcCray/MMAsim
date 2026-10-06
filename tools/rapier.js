// Resolves the Rapier physics engine for the node tools: the copy vendored here, or the
// MMAPhysics prototype's node_modules if that is around.
let R;
try { R = require('./rapier3d-compat.cjs'); }
catch (e) { R = require('../MMAPhysics/node_modules/@dimforge/rapier3d-compat'); }
module.exports = R;
