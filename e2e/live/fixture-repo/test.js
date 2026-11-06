/* global console */
import assert from 'node:assert/strict';
import { sum } from './src/sum.js';

assert.equal(sum(2, 3), 5);
console.log('1 test passed');
