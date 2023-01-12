import {compact, expand} from '../dist/snapshots.js';
import Fuzz from "jest-fuzz";

test('compacting empty should return empty', () => {
    expect(compact([])).toEqual([]);
});

test('compacting one snapshot should return empty', () => {
    expect(compact([{id: '1', snapshot: 1, treeId: '1', parentId: '1', position: 1, updatedAt: '1', delta: false, content: '1'}])).toEqual([]);
});

test('compacting two identical snapshots should return unchanged row', () => {
    const snapshot1 = [{id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: false, content: 'start'}];
    const snapshot2 = [{id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: false, content: 'start'}];
    const expectedDelta = [{id: 'unchanged', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '', delta: true, content: JSON.stringify(['1'])}];
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedDelta}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('compacting two single-card snapshots, content-only change', () => {
    const snapshot1 = [{id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: false, content: 'start'}];
    const snapshot2 = [{id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '2', delta: false, content: 'end'}];
    const expectedData = [{id: '1', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '1', delta: true, content: 'start'}]
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedData}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('compacting two single-card snapshots, content-only change (long)', () => {
    const snapshot1 = [{id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: false, content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nulla et vehicula lacus. Suspendisse sed magna luctus, venenatis purus sed, sollicitudin dolor. Aliquam a facilisis lacus. Aliquam suscipit vel elit ornare porttitor. Suspendisse facilisis tortor nec arcu elementum, quis mollis lectus semper. Donec sit amet nunc magna. Nullam id gravida mi. Cras eu diam porta, porttitor sem vel, vestibulum nisl. Quisque facilisis laoreet nisl ac auctor. Donec finibus viverra turpis, ac feugiat massa ultricies quis. Maecenas tempor mauris dapibus ex commodo, in vestibulum augue porta. Vestibulum at sem eu arcu gravida varius sit amet at dui. Ut mattis posuere dapibus. Cras imperdiet dignissim purus sed egestas.'}];
    const snapshot2 = [{id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '2', delta: false, content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nulla et vehicula lacus. Suspendisse sed magna luctus, venenatis purus sed, sollicitudin dolor. Aliquam a facilisis lacus. Aliquam suscipit vel elit ornare porttitor. Suspendisse facilisis tortor nec arcu elementum, quis mollis lectus semper. Donec sit amet nunc magna. Nullam id gravida mi. Cras eu diam porta, porttitor sem vel, vestibulum nisl. Quisque facilisis laoreet nisl ac auctor. Donec finibus viverra turpis, AN INSERTION HERE! ac feugiat massa ultricies quis. Maecenas tempor mauris dapibus ex commodo, in vestibulum augue porta. Vestibulum at sem eu arcu gravida varius sit amet at dui. Ut mattis posuere dapibus. Cras imperdiet dignissim purus sed egestas.'}];
    const expectedData = [{id: '1', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '1', delta: true, content: '~@%`>' + JSON.stringify([477, -19, 231])}];
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedData}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('compacting two single-card snapshots, content-only change (long, reversed)', () => {
    const snapshot1 = [{id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: false, content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nulla et vehicula lacus. Suspendisse sed magna luctus, venenatis purus sed, sollicitudin dolor. Aliquam a facilisis lacus. Aliquam suscipit vel elit ornare porttitor. Suspendisse facilisis tortor nec arcu elementum, quis mollis lectus semper. Donec sit amet nunc magna. Nullam id gravida mi. Cras eu diam porta, porttitor sem vel, vestibulum nisl. Quisque facilisis laoreet nisl ac auctor. Donec finibus viverra turpis, AN INSERTION HERE! ac feugiat massa ultricies quis. Maecenas tempor mauris dapibus ex commodo, in vestibulum augue porta. Vestibulum at sem eu arcu gravida varius sit amet at dui. Ut mattis posuere dapibus. Cras imperdiet dignissim purus sed egestas.'}];
    const snapshot2 = [{id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '2', delta: false, content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nulla et vehicula lacus. Suspendisse sed magna luctus, venenatis purus sed, sollicitudin dolor. Aliquam a facilisis lacus. Aliquam suscipit vel elit ornare porttitor. Suspendisse facilisis tortor nec arcu elementum, quis mollis lectus semper. Donec sit amet nunc magna. Nullam id gravida mi. Cras eu diam porta, porttitor sem vel, vestibulum nisl. Quisque facilisis laoreet nisl ac auctor. Donec finibus viverra turpis, ac feugiat massa ultricies quis. Maecenas tempor mauris dapibus ex commodo, in vestibulum augue porta. Vestibulum at sem eu arcu gravida varius sit amet at dui. Ut mattis posuere dapibus. Cras imperdiet dignissim purus sed egestas.'}];
    const expectedData = [{id: '1', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '1', delta: true, content: '~@%`>' + JSON.stringify([477, "AN INSERTION HERE! ", 231])}];
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedData}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('compacting two single-card snapshots, move-only change', () => {
    const snapshot1 = [{id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: false, content: 'start'}];
    const snapshot2 = [{id: '1', snapshot: 2, treeId: '1', parentId: 'non-existant', position: 2.5, updatedAt: '2', delta: false, content: 'start'}];
    const expectedData = [{id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '1', delta: true, content: null}];
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedData}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('compacting two single-card snapshots, move-only change (reversed)', () => {
    const snapshot1 = [{id: '1', snapshot: 1, treeId: '1', parentId: 'non-existant', position: 2.5, updatedAt: '1', delta: false, content: 'start'}];
    const snapshot2 = [{id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '2', delta: false, content: 'start'}];
    const expectedData = [{id: '1', snapshot: 1, treeId: '1', parentId: 'non-existant', position: 2.5, updatedAt: '1', delta: true, content: null}];
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedData}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('various changes', () => {
    const snapshot1 = [
        {id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '976', delta: false, content: 'Ok, some things'},
        {id: '2', snapshot: 1, treeId: '1', parentId: '5', position: 0, updatedAt: '449', delta: false, content: ': lest'},
        {id: '3', snapshot: 1, treeId: '1', parentId: '1', position: 0, updatedAt: '371', delta: false, content: ' asdfsdaf asdf'},
        {id: '4', snapshot: 1, treeId: '1', parentId: '1', position: 1, updatedAt: '607', delta: false, content: 'Mid child'},
        {id: '5', snapshot: 1, treeId: '1', parentId: '1', position: 2, updatedAt: '455', delta: false, content: 'New card'}
    ];
    const snapshot2 = [
        {id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '976', delta: false, content: 'Ok, some things'},
        {id: '2', snapshot: 2, treeId: '1', parentId: '5', position: 0, updatedAt: '748', delta: false, content: 'A change'},
        {id: '3', snapshot: 2, treeId: '1', parentId: '1', position: 0, updatedAt: '845', delta: false, content: 'No keyboard mashing'},
        {id: '5', snapshot: 2, treeId: '1', parentId: null, position: 1, updatedAt: '690', delta: false, content: 'New card'}
    ];
    const expectedData = [
        {id: 'unchanged', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '', delta: true, content: JSON.stringify(['1'])},
        {id: '3', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '371', delta: true, content: " asdfsdaf asdf"},
        {id: '2', snapshot: 1, treeId: '1', parentId: 0, position: null, updatedAt: '449', delta: true, content: ": lest"},
        {id: '5', snapshot: 1, treeId: '1', parentId: '1', position: 2, updatedAt: '455', delta: true, content: null},
        {id: '4', snapshot: 1, treeId: '1', parentId: '1', position: 1, updatedAt: '607', delta: true, content: 'Mid child'}
    ];
    const expected = [{snapshot: 1, treeId: '1', compactedData: expectedData}];
    expect(compact([...snapshot1, ...snapshot2])).toEqual(expected);
});

test('various changes, encode then decode', () => {
    const snapshot1 = [
        {id: '1', snapshot: 1, treeId: '1', parentId: null, position: 0, updatedAt: '976', delta: false, content: 'Ok, some things'},
        {id: '2', snapshot: 1, treeId: '1', parentId: '5', position: 0, updatedAt: '449', delta: false, content: ': lest'},
        {id: '3', snapshot: 1, treeId: '1', parentId: '1', position: 0, updatedAt: '371', delta: false, content: ' asdfsdaf asdf'},
        {id: '4', snapshot: 1, treeId: '1', parentId: '1', position: 1, updatedAt: '607', delta: false, content: 'Mid child'},
        {id: '5', snapshot: 1, treeId: '1', parentId: '1', position: 2, updatedAt: '455', delta: false, content: 'New card'}
    ];
    const snapshot2 = [
        {id: '1', snapshot: 2, treeId: '1', parentId: null, position: 0, updatedAt: '976', delta: false, content: 'Ok, some things'},
        {id: '2', snapshot: 2, treeId: '1', parentId: '5', position: 0, updatedAt: '748', delta: false, content: 'A change'},
        {id: '3', snapshot: 2, treeId: '1', parentId: '1', position: 0, updatedAt: '845', delta: false, content: 'No keyboard mashing'},
        {id: '5', snapshot: 2, treeId: '1', parentId: null, position: 1, updatedAt: '690', delta: false, content: 'New card'}
    ];
    const compactResult = compact([...snapshot1, ...snapshot2])[0].compactedData.sort((a, b) => a.id.localeCompare(b.id));
    const expandedResult = expand(snapshot2, compactResult).sort((a, b) => a.id.localeCompare(b.id));
    expect(expandedResult).toEqual(snapshot1);
});

const snapshotFuzzer = Fuzz.Fuzzer({
    id: Fuzz.string({length: 5}),
    content: Fuzz.string(),
    parentId: Fuzz.string({length: 5}),
    position: Fuzz.float({min: -100, max: 100}),
    updatedAt: Fuzz.string({length: 24}),
});

Fuzz.test('fuzz test <= 100 cards', Fuzz.array({type: snapshotFuzzer(), length: 100}), (snapshotFuzzed) => {
    const snapshot1 = snapshotFuzzed.map((card, i) => ({...card, snapshot: 1, treeId: '1', delta: false}));
    const snapshot2 = snapshot1.map((card) => ({...card, snapshot: 2}));
    const compactResult = compact([...snapshot1, ...snapshot2])[0].compactedData.sort((a, b) => a.id.localeCompare(b.id));
    const expandedResult = expand(snapshot2, compactResult).sort((a, b) => a.id.localeCompare(b.id));
    expect(expandedResult).toEqual(snapshot1);
})