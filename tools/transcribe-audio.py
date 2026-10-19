"""Independent ASR followed by acoustic alignment of the TTS script. Never divide time evenly."""
import json
import os
import sys
from pathlib import Path
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
# Keep DLL-directory handles alive: the bundled Python has the VC runtime outside System32.
_dll_dirs = []
if os.name == 'nt':
    candidates = [Path(sys.base_prefix), Path(sys.base_prefix).parent / 'native/poppler/Library/bin']
    if os.environ.get('VS_SPEECH_DLL_DIR'):
        candidates.append(Path(os.environ['VS_SPEECH_DLL_DIR']))
    for directory in candidates:
        if directory.is_dir():
            _dll_dirs.append(os.add_dll_directory(str(directory)))
from faster_whisper import WhisperModel
import wave
import numpy as np
import re
import unicodedata
from difflib import SequenceMatcher
from alignment_boundaries import reconcile_boundaries
from faster_whisper.audio import pad_or_trim
from faster_whisper.tokenizer import Tokenizer
sys.stdout.reconfigure(encoding="utf-8")

request = json.load(open(sys.argv[1], encoding="utf-8"))
def progress(stage, percent):
    Path(sys.argv[1] + '.progress.json').write_text(json.dumps(dict(stage=stage, percent=percent)), encoding='utf-8')

model_name = request.get("model", "small")
progress('loading local speech model', 30)
model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=4,
                     download_root=request["model_dir"])
with wave.open(request['audio'], 'rb') as source:
    if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != 16000:
        raise RuntimeError('Transcription requires the studio mono 16kHz PCM extraction')
    samples = np.frombuffer(source.readframes(source.getnframes()), dtype='<i2').astype(np.float32) / 32768.0
progress('transcribing the actual narration audio', 45)
segments, info = model.transcribe(
    samples, language=request.get("language"), beam_size=5,
    word_timestamps=True, vad_filter=True, condition_on_previous_text=False,
    # A full script used as an initial prompt can make Whisper skip its beginning as
    # previously spoken context. Decode the recording independently instead.
    initial_prompt=None,
)
result = []
for segment in segments:
    words = []
    for word in segment.words or []:
        text = word.word.strip()
        if not text or word.end <= word.start:
            continue
        words.append(dict(text=text, start=round(word.start, 3), end=round(word.end, 3),
                          probability=round(word.probability, 4)))
    if words:
        result.append(dict(start=words[0]["start"], end=words[-1]["end"],
                           text=" ".join(w["text"] for w in words), words=words))
if not result:
    raise RuntimeError("No timed speech recognised in the final narration")
raw_text = ' '.join(s['text'] for s in result)
Path(sys.argv[1] + '.recognised.json').write_text(json.dumps(dict(text=raw_text, language=info.language, segments=result), ensure_ascii=False), encoding='utf-8')
reference = str(request.get('vocabulary') or '').strip()
boundary_repairs = 0
if reference:
    progress('checking spoken text and aligning Darija spelling', 62)
    # First recognise independently. Then align the known TTS transcript acoustically:
    # the Darija spelling/product names must not be replaced by ASR misspellings.
    # ASR is used only to choose bounded audio windows; every final word boundary
    # comes from Whisper's cross-attention/DTW forced alignment of that window.
    def norm(text):
        text = unicodedata.normalize('NFKC', text).lower()
        text = re.sub('[\u064b-\u065f\u0670\u0640]', '', text)
        text = re.sub('[أإآ]', 'ا', text).replace('ة', 'ه').replace('ى', 'ي')
        return re.sub(r'[^\w]', '', text)

    refs = reference.split()
    observed = [w for s in result for w in s['words']]
    a, b = [norm(w) for w in refs], [norm(w['text']) for w in observed]
    if SequenceMatcher(None, ''.join(a), ''.join(b), autojunk=False).ratio() < .5:
        raise RuntimeError('Recognised speech does not sufficiently match the requested narration')
    n, m = len(a), len(b)
    costs = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1): costs[i][0] = i * .8
    for j in range(m + 1): costs[0][j] = j * .8
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            substitution = 1 - SequenceMatcher(None, a[i - 1], b[j - 1]).ratio()
            costs[i][j] = min(costs[i - 1][j - 1] + substitution, costs[i - 1][j] + .8, costs[i][j - 1] + .8)
    mapped, i, j = {}, n, m
    while i or j:
        if i and j:
            substitution = 1 - SequenceMatcher(None, a[i - 1], b[j - 1]).ratio()
            if abs(costs[i][j] - costs[i - 1][j - 1] - substitution) < 1e-5:
                mapped[i - 1] = j - 1; i -= 1; j -= 1; continue
        if i and abs(costs[i][j] - costs[i - 1][j] - .8) < 1e-5: i -= 1
        else: j -= 1

    duration = len(samples) / 16000
    cuts = [(0, 0.0)]
    for ref_index, asr_index in sorted(mapped.items()) if duration > 29.9 else []:
        timestamp = observed[asr_index]['start']
        if timestamp - cuts[-1][1] >= 18 and ref_index > cuts[-1][0] and duration - timestamp > 2:
            cuts.append((ref_index, timestamp))
    cuts.append((n, duration))
    tokenizer = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task='transcribe', language=info.language)
    aligned = []
    for chunk_index, ((begin, start), (finish, end)) in enumerate(zip(cuts, cuts[1:])):
        progress('acoustic word alignment ' + str(chunk_index + 1) + '/' + str(len(cuts) - 1), 65 + int(20 * chunk_index / (len(cuts) - 1)))
        context_begin, context_end = max(0, begin - 3), min(n, finish + 3)
        nearby_start = mapped.get(context_begin)
        nearby_end = mapped.get(context_end - 1)
        window_start = max(0, min(start, observed[nearby_start]['start'] if nearby_start is not None else start - 1.5) - .4) if begin else 0
        window_end = min(duration, max(end, observed[nearby_end]['end'] if nearby_end is not None else end + 1.5) + .4) if finish < n else duration
        if window_end - window_start > 29.9:
            raise RuntimeError('No safe ASR boundary for forced alignment; narration was not uniformly divided')
        features = model.feature_extractor(samples[int(window_start * 16000):int(window_end * 16000)])
        context_text = ' '.join(refs[context_begin:context_end])
        core_start = len(' '.join(refs[context_begin:begin])) + (1 if begin > context_begin else 0)
        core_end = len(' '.join(refs[context_begin:finish]))
        matches = model.find_alignment(tokenizer, [tokenizer.encode(context_text)],
                                       model.encode(pad_or_trim(features)), features.shape[-1])[0]
        pending = ''
        chunk = []
        cursor = 0
        for w in matches:
            raw = w['word']
            position = cursor + len(raw) - len(raw.lstrip())
            cursor += len(raw)
            if position < core_start or position >= core_end:
                continue
            text = raw.strip()
            if not text: continue
            if chunk and not raw[0].isspace():
                chunk[-1]['text'] += text
                chunk[-1]['end'] = max(chunk[-1]['end'], round(window_start + float(w['end']), 3))
                continue
            if not norm(text) and chunk:
                chunk[-1]['text'] += text
                continue
            if w['end'] <= w['start']:
                pending += text + ' '
                continue
            chunk.append(dict(text=pending + text, start=round(window_start + float(w['start']), 3),
                              end=round(window_start + float(w['end']), 3), probability=round(float(w['probability']), 4)))
            pending = ''
        if pending and chunk: chunk[-1]['text'] += ' ' + pending.strip()
        if not chunk: raise RuntimeError('No acoustic alignment for a narration window')
        aligned.extend(chunk)
    boundary_repairs = reconcile_boundaries(aligned, observed, norm)
    for previous, following in zip(aligned, aligned[1:]):
        if previous['end'] > following['start']:
            if previous['end'] - following['start'] > .16 or following['start'] <= previous['start']:
                raise RuntimeError('Forced alignment windows disagree: ' + repr((previous, following)))
            previous['end'] = following['start']
    result = [dict(start=aligned[0]['start'], end=aligned[-1]['end'], text=reference, words=aligned)]
progress('validating the complete aligned transcript', 88)
print(json.dumps(dict(language=info.language, languageProbability=info.language_probability,
                     text=" ".join(s["text"] for s in result), segments=result,
                     recognisedText=raw_text, alignment=('cross_attention_dtw_with_asr_boundary_reconciliation' if boundary_repairs else 'cross_attention_dtw') if reference else 'asr', boundaryRepairs=boundary_repairs,
                     model=model_name), ensure_ascii=False))
