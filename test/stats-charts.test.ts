/**
 * The chart layer's arithmetic, without a DOM: heatmap level thresholds, the
 * forecast's label placement, the histogram's binning, and the axis top. The
 * rendering itself is exercised in `stats-view.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { dayHistogramCap, forecastLabelIndices, heatmapLevel, heatmapThresholds, histogramBins, niceAxisTop } from '../ui/stats-charts';

test('heatmap thresholds spread the colours over whatever the data is', () => {
    assert.deepEqual(heatmapThresholds([]), [1, 2, 3, 4], 'an empty grid is ready for any count');
    assert.deepEqual(heatmapThresholds([1, 1, 1, 4]), [1, 2, 3, 4], 'one standout day stays visibly the darkest');
    assert.deepEqual(heatmapThresholds([1, 2, 3, 4]), [1, 2, 3, 4]);
    assert.deepEqual(heatmapThresholds([2, 2, 3]), [2, 2, 3, 4]);
});

test('a non-zero day is never drawn as an empty one', () => {
    const thresholds = [1, 2, 3, 4];
    assert.equal(heatmapLevel(0, thresholds), 0);
    assert.equal(heatmapLevel(1, thresholds), 1);
    assert.equal(heatmapLevel(2, thresholds), 2);
    assert.equal(heatmapLevel(3, thresholds), 3);
    assert.equal(heatmapLevel(4, thresholds), 4);
    assert.equal(heatmapLevel(9, thresholds), 4);
    assert.equal(heatmapLevel(1, [4, 4, 4, 4]), 1, 'a quiet day on a busy week still shows');
});

test('forecast x labels keep their distance', () => {
    assert.deepEqual(forecastLabelIndices(1, 12, 58), [0]);
    assert.deepEqual(forecastLabelIndices(30, 12, 58), [0, 5, 10, 15, 20, 25, 29]);
    const labels = forecastLabelIndices(30, 12, 58);
    for (let index = 1; index < labels.length; index++) {
        assert.ok((labels[index] - labels[index - 1]) * 12 >= 46, 'labels are at least ~46px apart');
    }
    assert.deepEqual(forecastLabelIndices(5, 60, 58), [0, 1, 2, 3, 4], 'room allows a label per day');
    assert.deepEqual(forecastLabelIndices(30, 18), [0, 6, 12, 18, 24, 29], 'the default gap keeps the label row quiet');
});

test('histogram bins cover the data, pool the overflow, and start near offset data', () => {
    const empty = histogramBins([]);
    assert.deepEqual(empty.bins, [0]);
    assert.equal(empty.median, null);

    const longTail = histogramBins([1, 1, 2, 2, 3, 40]);
    assert.equal(longTail.bins.reduce((sum, count) => sum + count, 0), 6, 'every value lands in a bin');
    assert.equal(longTail.overflow, 1, 'the far value pools into the last bin');
    assert.equal(longTail.median, 2);
    assert.ok(longTail.edges[longTail.edges.length - 1] >= 40, 'the axis reaches the cap');

    const eases = histogramBins([2300, 2400, 2500, 2600]);
    assert.equal(eases.edges[0], 2000, 'ease factors do not start their axis at an empty zero');
    assert.deepEqual(eases.bins, [2, 2]);

    const equal = histogramBins([5, 5, 5]);
    assert.equal(equal.bins.reduce((sum, count) => sum + count, 0), 3);
});

test('the axis top is a round number above the data', () => {
    assert.equal(niceAxisTop(0), 1);
    assert.equal(niceAxisTop(15), 15);
    assert.equal(niceAxisTop(23), 30);
});

test('a day histogram caps its axis so one outlier cannot flatten the rest', () => {
    assert.equal(dayHistogramCap([]), 60);
    assert.equal(dayHistogramCap([2, 3, 4]), 4, 'a small collection uses its own range');
    assert.equal(dayHistogramCap([2, 3, 4, 5, 6, 7, 8, 9, 246]), 60, 'the lone 246-day interval does not own the axis');

    const capped = histogramBins([2, 3, 246], 7, 95, 60);
    assert.equal(capped.bins.reduce((sum, count) => sum + count, 0), 3);
    assert.equal(capped.overflow, 1, 'the outlier pools into the last bin');
});
