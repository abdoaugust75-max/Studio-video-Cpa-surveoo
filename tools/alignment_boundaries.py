"""Reconcile conflicting DTW windows using independently recognised audio times.

No interpolation, duration spreading or invented boundaries. If nearby recognised
words are uncertain or disagree, leave the conflict for the caller to reject.
"""
from difflib import SequenceMatcher


def reconcile_boundaries(aligned, observed, normalize):
    repaired = 0
    for _ in range(3):
        changed = False
        for previous, following in zip(aligned, aligned[1:]):
            if previous['end'] - following['start'] <= .16 and following['start'] > previous['start']:
                continue
            if abs(previous['end'] - following['start']) > 1.0:
                continue

            def match(target):
                candidates = []
                for index, word in enumerate(observed):
                    if abs(word['start'] - target['start']) > 1.25 or word['end'] <= word['start']:
                        continue
                    similarity = SequenceMatcher(None, normalize(target['text']), normalize(word['text'])).ratio()
                    if similarity < .72 or word.get('probability', 0) < .55:
                        continue
                    candidates.append((similarity - abs(word['start'] - target['start']) * .08, index, word))
                return max(candidates, default=None, key=lambda c: c[0])

            left, right = match(previous), match(following)
            if not left or not right or left[1] >= right[1] or left[2]['end'] > right[2]['start']:
                continue
            for target, source in [(previous, left[2]), (following, right[2])]:
                target['start'], target['end'] = source['start'], source['end']
                target['timingSource'] = 'independent_asr_boundary'
            repaired += 1
            changed = True
        if not changed:
            break
    return repaired


if __name__ == '__main__':
    normalize = lambda s: s.strip('.').replace('فال', '').replace('ال', '')
    aligned = [dict(text='فالتصوير.', start=36.48, end=37.42), dict(text='الهاتف', start=37.2, end=38.08)]
    observed = [dict(text='تصوير', start=36.46, end=36.94, probability=.819), dict(text='الهاتف', start=36.94, end=38.06, probability=.967)]
    assert reconcile_boundaries(aligned, observed, normalize) == 1
    assert aligned[0]['end'] == aligned[1]['start'] == 36.94
    wrong = [dict(text='different', start=1, end=2.3), dict(text='speech', start=2, end=3)]
    assert reconcile_boundaries(wrong, observed, normalize) == 0
    assert wrong[0]['end'] == 2.3
    print('Independent acoustic boundary reconciliation passed; no inferred timestamps.')
