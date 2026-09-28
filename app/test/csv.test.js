import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, toCSV } from '../js/csv.js';

test('parseCSV splits plain rows', () => {
  assert.deepEqual(parseCSV('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parseCSV handles a trailing newline without adding a phantom empty row', () => {
  assert.deepEqual(parseCSV('a,b\nc,d\n'), [['a', 'b'], ['c', 'd']]);
});

test('parseCSV handles a quoted field containing a comma', () => {
  assert.deepEqual(parseCSV('"Doe, John",5\nAma,7'), [['Doe, John', '5'], ['Ama', '7']]);
});

test('parseCSV handles an escaped quote inside a quoted field', () => {
  assert.deepEqual(parseCSV('"She said ""hi""",1'), [['She said "hi"', '1']]);
});

test('parseCSV handles a newline embedded inside a quoted field', () => {
  assert.deepEqual(parseCSV('"line one\nline two",x'), [['line one\nline two', 'x']]);
});

test('parseCSV tolerates \\r\\n line endings', () => {
  assert.deepEqual(parseCSV('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
});

test('parseCSV returns nothing for empty input', () => {
  assert.deepEqual(parseCSV(''), []);
});

test('toCSV only quotes fields that need it', () => {
  assert.equal(toCSV([['name', 'note'], ['Ama', 'plain'], ['Kofi', 'has "quote"']]),
    'name,note\nAma,plain\nKofi,"has ""quote"""');
});

test('toCSV quotes a field containing a comma', () => {
  assert.equal(toCSV([['Doe, John', '5']]), '"Doe, John",5');
});

test('toCSV/parseCSV round-trip through commas, quotes and blank cells', () => {
  const rows = [['Name', 'Device ID', 'Note'], ['Doe, "Jack" John', '12', ''], ['Ama', '', 'fine']];
  assert.deepEqual(parseCSV(toCSV(rows)), rows);
});
