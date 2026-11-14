/**
 * Bring an element to the middle of the panel that scrolls it — the way a
 * read-aloud "follow" should move: the line being read sits in the centre and
 * the view glides with it, instead of creeping to the bottom edge and jumping
 * as `block: 'nearest'` does.
 *
 * Only the nearest scrolling ancestor moves. `scrollIntoView` also scrolls
 * every `overflow: hidden` box above it, which nudged the dock and the note
 * out of place.
 */
export function centerInScroller(el: HTMLElement, smooth = true): void {
    const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';
    const scroller = typeof getComputedStyle === 'function' ? findScroller(el) : null;
    if (!scroller || typeof scroller.scrollTo !== 'function') {
        el.scrollIntoView?.({ behavior, block: 'center' });
        return;
    }
    const box = scroller.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const offset = rect.top - box.top + scroller.scrollTop;
    // Taller than the panel: its first line goes near the top instead, so the
    // reader sees where it starts rather than its middle.
    const top = rect.height >= scroller.clientHeight
        ? offset - 16
        : offset - (scroller.clientHeight - rect.height) / 2;
    scroller.scrollTo({ top: Math.max(0, Math.round(top)), behavior });
}

function findScroller(el: HTMLElement): HTMLElement | null {
    let node = el.parentElement;
    while (node) {
        const overflow = getComputedStyle(node).overflowY;
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
        node = node.parentElement;
    }
    return null;
}
