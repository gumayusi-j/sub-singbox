// Runtime module resolver so '@/...' imports resolve to the src/ root,
// independent of babel-plugin-relative-path-import (which miscalculates
// relative paths on Windows). Load with `node -r ./preload`.
const Module = require('module');
const path = require('path');

const SRC = path.resolve(__dirname, 'src');
const origResolve = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
    if (typeof request === 'string' && request.startsWith('@/')) {
        const target = path.join(SRC, request.slice(2));
        return origResolve.call(this, target, parent, isMain, options);
    }
    return origResolve.apply(this, arguments);
};
