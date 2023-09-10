import _ from 'lodash';
// @ts-ignore
import diff from 'textdiff-create';
// @ts-ignore
import patch from 'textdiff-patch';
function isDeltaStringified(d) {
    return d.delta;
}
function isCard(c) {
    return !c.delta;
}
// =============
export function compact(snapshotRows) {
    const snapshots = _.chain(snapshotRows).sortBy('snapshot').groupBy('snapshot').values().value();
    if (snapshots.length == 0 || snapshots.length == 1) {
        return [];
    }
    const result = [];
    for (let i = 1; i < snapshots.length; i++) {
        const oldSnapshot = snapshots[i - 1];
        const currSnapshot = snapshots[i];
        if (currSnapshot[0].delta == false, oldSnapshot[0].delta == false) {
            // Replace oldSnapshot with a delta-encoded version
            result.push({ snapshot: oldSnapshot[0].snapshot, treeId: oldSnapshot[0].treeId, compactedData: delta(currSnapshot, oldSnapshot) });
        }
    }
    return result;
}
function delta(fromCards, toCards) {
    const deltasRaw = [];
    const allCardIds = new Set([...fromCards.map(c => c.id), ...toCards.map(c => c.id)]);
    allCardIds.forEach(cardId => {
        const fromCard = fromCards.find(c => c.id == cardId);
        const toCard = toCards.find(c => c.id == cardId);
        if (fromCard && toCard) {
            deltasRaw.push(cardDiff(fromCard, toCard));
        }
        else if (!fromCard && toCard) {
            deltasRaw.push({ ...toCard, delta: true, unchanged: false });
        }
    });
    const [unchanged, changed] = _.partition(deltasRaw, d => d.unchanged);
    const unchangedIds = unchanged.map(d => d.id);
    if (unchangedIds.length > 0) {
        const unchanged = { id: 'unchanged', content: JSON.stringify(unchangedIds), position: null, parentId: 0, snapshot: toCards[0].snapshot, treeId: toCards[0].treeId, updatedAt: '', delta: true, unchanged: true };
        return _.sortBy([unchanged, ...changed].map(stringifyDelta), 'updatedAt');
    }
    else {
        return _.sortBy(changed.map(stringifyDelta), 'updatedAt');
    }
}
function stringifyDelta(d) {
    let newContent;
    if (d.content == null || typeof d.content == 'string') {
        newContent = d.content;
    }
    else {
        newContent = JSON.stringify(d.content);
    }
    return { id: d.id, content: newContent, position: d.position, parentId: d.parentId, snapshot: d.snapshot, treeId: d.treeId, updatedAt: d.updatedAt, delta: true };
}
function cardDiff(fromCard, toCard) {
    const contentChanged = fromCard.content != toCard.content;
    const parentChanged = fromCard.parentId != toCard.parentId;
    const positionChanged = fromCard.position != toCard.position;
    const unchanged = !contentChanged && !parentChanged && !positionChanged;
    const contentDiffArray = diff(fromCard.content, toCard.content).map(diffMinimizer);
    const contentDiff = JSON.stringify(contentDiffArray);
    const newContent = (contentDiff.length > toCard.content.length + 5) ? toCard.content : "~@%`>" + contentDiff;
    const content = contentChanged ? newContent : null;
    const parentId = parentChanged ? toCard.parentId : 0;
    const position = positionChanged ? toCard.position : null;
    return { id: toCard.id, content, position, parentId, snapshot: toCard.snapshot, treeId: toCard.treeId, updatedAt: toCard.updatedAt, delta: true, unchanged };
}
function diffMinimizer(d) {
    const EQUAL = 0;
    const INSERT = 1;
    const DELETE = -1;
    if (d[0] == EQUAL) {
        return d[1];
    }
    else if (d[0] == INSERT) {
        return d[1];
    }
    else if (d[0] == DELETE) {
        return -d[1];
    }
    else {
        throw new Error('Invalid diff');
    }
}
export function diffMaximizer(d) {
    const EQUAL = 0;
    const INSERT = 1;
    const DELETE = -1;
    if (typeof d == 'number') {
        if (d > 0) {
            return [EQUAL, d];
        }
        else {
            return [DELETE, -d];
        }
    }
    else {
        return [INSERT, d];
    }
}
export function expand(snapshotRows) {
    const snapshots = _.chain(snapshotRows)
        .groupBy('snapshot')
        .values()
        .map(s => _.sortBy(s, ['snapshot', 'updatedAt']))
        .reverse()
        .value();
    for (let i = 1; i < snapshots.length; i++) {
        const oldSnapshot = snapshots[i - 1];
        const currSnapshot = snapshots[i];
        if (isDeltaStringified(currSnapshot[0]) && isCard(oldSnapshot[0])) {
            snapshots[i] = expandSnapshot(oldSnapshot, currSnapshot);
        }
    }
    // @ts-ignore
    return _.chain(snapshots).flatten().sortBy(['snapshot', 'updatedAt']).value();
}
export function expandSnapshot(base, deltas) {
    const result = [];
    deltas.forEach(delta => {
        if (delta.id == 'unchanged' && delta.content !== null) {
            result.push(...base.filter(c => (JSON.parse(delta.content).includes(c.id))).map(c => ({ ...c, snapshot: delta.snapshot })));
        }
        else {
            result.push(expandCard(base, delta));
        }
    });
    return result;
}
function expandCard(base, delta) {
    const baseCard = base.find(c => c.id == delta.id);
    if (!baseCard) {
        // Doesn't exist in base, so just return the delta
        return { ...delta, content: delta.content, snapshot: delta.snapshot, delta: false };
    }
    else {
        const snapshot = delta.snapshot;
        const content = delta.content == null ? baseCard.content : expandContent(baseCard.content, delta.content);
        const parentId = delta.parentId == 0 ? baseCard.parentId : delta.parentId;
        const position = delta.position == null ? baseCard.position : delta.position;
        const updatedAt = delta.updatedAt;
        return { ...baseCard, snapshot, content, parentId, position, updatedAt, delta: false };
    }
}
function expandContent(baseContent, deltaContent) {
    if (deltaContent.startsWith("~@%`>")) {
        const diffArray = JSON.parse(deltaContent.slice(5));
        const diff = diffArray.map(diffMaximizer);
        return patch(baseContent, diff);
    }
    else {
        return deltaContent;
    }
}
//# sourceMappingURL=snapshots.js.map