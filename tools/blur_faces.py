#!/usr/bin/env python3
"""Blur every head in the shipped close-up (crop.jpgs) and 360 (pano.jpgs) frames, in place (single use, after
build_snippets.py --with-video). Run in an env with ultralytics (e.g. the source repo's `trashbot` env).

Heads = union of (1) a YOLO face detector and (2) YOLO pose head keypoints (nose, eyes, ears) of every person, or the
top fifth of the person box when no head keypoint is seen; low thresholds (misses cost more than false blurs), heads
from the pose detector larger than MAX_HEAD dropped (false detections), boxes enlarged and held over +-2 frames
against flicker; a frame without a face or a confident person with head keypoints is blurred whole (e.g. a face
filling the close-up). The 360 frames (960 x 480) are padded across the left / right seam
and upscaled x3 before detection (heads are a few pixels tall). Blur: each head ellipse pixelated to 3 x 3 cells and blurred.
Writes scene.json media offsets and media.blurred = true (the viewer shows no frames without it); skips snippets
already blurred. The shipped frames were made with yolov11l-face.pt and yolo11x-pose.pt, from the source repo:
  conda run -n trashbot python ../trashbot-hri-3d-viewer/tools/blur_faces.py --face <yolov11l-face.pt> \
      --pose <yolo11x-pose.pt> --raw <unblurred copy of web/snippets> --cache <dir> --check <dir>
then every check sheet was looked at (no face left visible; distant people a few pixels tall are left as is).
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

HOLD = 2  # frames a head box is kept before / after its detection
FACE_CONF, PERSON_CONF, KP_CONF = 0.15, 0.25, 0.2  # low: a missed face costs more than a false blur
SURE = 0.5  # a frame without a face or a person with head keypoints at this confidence is blurred whole
MAX_HEAD = 0.35  # largest head from the pose detector, fraction of the image height (larger = false detection)


def detect(img, face, pose, up, pad):
    """Raw detections in img pixels: faces (n, 5) xyxy conf, persons (n, 20) xyxy conf + 5 head keypoints (x, y, conf).
    img is padded by `pad` px of wrap on both sides and upscaled by `up` (detection at full resolution)."""
    w = img.shape[1]
    big = np.concatenate([img[:, w - pad:], img, img[:, :pad]], 1) if pad else img
    big = cv2.resize(big, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC) if up != 1 else big
    sz = -(-max(big.shape[:2]) // 32) * 32
    r = face(big, conf=0.05, imgsz=sz, verbose=False)[0]
    f = np.c_[r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy()].reshape(-1, 5)
    r = pose(big, conf=0.05, imgsz=sz, verbose=False)[0]
    k = r.keypoints.data.cpu().numpy()[:, :5].reshape(len(r.boxes), 15)
    p = np.c_[r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy(), k].reshape(-1, 20)
    for d in (f, p):
        d[:, :4] /= up
        d[:, [0, 2]] -= pad
    p[:, 5:] /= np.tile([up, up, 1], 5)
    p[:, 5::3] -= pad
    return f, p


def heads(f, p, w, h, wrap):
    """Head boxes (x0, y0, x1, y1): faces, person head keypoints (nose, eyes, ears), or the top of the person box when
    no head keypoint is seen (back turned, occluded); wrapped copies across the 360 seam."""
    out, n = [b[:4] for b in f if b[4] >= FACE_CONF], int((f[:, 4] >= FACE_CONF).sum())
    sure = bool((f[:, 4] >= SURE).any())  # a clear face, or a confident person with head keypoints
    for b in p:
        if b[4] < PERSON_CONF:
            continue
        k = b[5:].reshape(5, 3)
        hk, bh = k[k[:, 2] > KP_CONF, :2], b[3] - b[1]
        if len(hk):
            sure |= b[4] >= SURE
            c, s = hk.mean(0), max(np.ptp(hk, 0).max() * 1.6, 0.12 * bh)
            out.append(np.r_[c - s / 2, c + s / 2])
        else:
            cx, s = (b[0] + b[2]) / 2, max(0.2 * bh, 0.6 * (b[2] - b[0]))
            out.append(np.r_[cx - s / 2, b[1], cx + s / 2, b[1] + s])
    boxes = []
    for i, b in enumerate(out):
        if i >= n and max(b[2] - b[0], b[3] - b[1]) > MAX_HEAD * h:
            continue
        boxes.append(b)
        if wrap and (b[0] < 0 or b[2] > w):
            boxes.append(b + ([w, 0, w, 0] if b[0] < 0 else [-w, 0, -w, 0]))
    return boxes, sure


def blur(img, boxes, grow=1.6):
    """Each head ellipse (box enlarged by `grow`) replaced by its 3 x 3 pixelated, blurred self."""
    out = img.astype(np.float32)
    h, w = img.shape[:2]
    for x0, y0, x1, y1 in sorted(boxes, key=lambda b: -(b[2] - b[0]) * (b[3] - b[1])):  # large first, then blur the
        # already blurred image (a small box inside a large one must not bring the features back)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        ax, ay = max(4, (x1 - x0) * grow / 2), max(4, (y1 - y0) * grow / 2)
        X0, X1 = max(0, int(cx - ax) - 2), min(w, int(cx + ax) + 3)
        Y0, Y1 = max(0, int(cy - ay) - 2), min(h, int(cy + ay) + 3)
        if X1 - X0 < 2 or Y1 - Y0 < 2:
            continue
        roi = out[Y0:Y1, X0:X1]
        n = 3
        small = cv2.resize(roi, (max(1, round(n * (X1 - X0) / max(X1 - X0, Y1 - Y0))),
                                 max(1, round(n * (Y1 - Y0) / max(X1 - X0, Y1 - Y0)))), interpolation=cv2.INTER_AREA)
        soft = cv2.resize(small, (X1 - X0, Y1 - Y0), interpolation=cv2.INTER_LINEAR)
        k = int(2 * ax) | 1
        soft = cv2.GaussianBlur(soft, (k, k), 0)
        m = np.zeros((Y1 - Y0, X1 - X0), np.float32)
        cv2.ellipse(m, (round(cx - X0), round(cy - Y0)), (round(ax), round(ay)), 0, 0, 360, 1.0, -1)
        m = cv2.GaussianBlur(m, (5, 5), 0)[..., None]
        out[Y0:Y1, X0:X1] = out[Y0:Y1, X0:X1] * (1 - m) + soft * m
    return out.clip(0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--snippets", default=str(Path(__file__).resolve().parents[1] / "web/snippets"))
    ap.add_argument("--face", required=True, help="YOLO face weights (e.g. yolov11l-face.pt)")
    ap.add_argument("--pose", required=True, help="YOLO pose weights (e.g. yolo11x-pose.pt)")
    ap.add_argument("--raw", help="read the unblurred frames and scene.json from this copy of web/snippets (reruns)")
    ap.add_argument("--cache", help="directory to cache the detections in (reruns)")
    ap.add_argument("--check", help="directory for check sheets: frames and every person's upper body (to look at)")
    a = ap.parse_args()
    face, pose = YOLO(a.face), YOLO(a.pose)
    for sj in sorted(Path(a.snippets).glob("*/scene.json")):
        src = Path(a.raw) / sj.parent.name if a.raw else sj.parent
        sc = json.loads((src / "scene.json").read_text())
        media = sc.get("media", {})
        if media.get("blurred") or not any(k in media for k in ("crop", "pano")):
            continue
        for kind in ("crop", "pano"):
            if kind not in media:
                continue
            f, off = sj.parent / f"{kind}.jpgs", media[kind]
            data = (src / f"{kind}.jpgs").read_bytes()
            imgs = [cv2.imdecode(np.frombuffer(data[off[i]:off[i + 1]], np.uint8), cv2.IMREAD_COLOR)
                    for i in range(len(off) - 1)]
            up, pad = (3, 120) if kind == "pano" else (1, 0)
            cf = Path(a.cache) / f"{sj.parent.name}_{kind}.npz" if a.cache else None
            if cf and cf.exists():
                z = np.load(cf)
                raw = [(z[f"f{i}"], z[f"p{i}"]) for i in range(len(imgs))]
            else:
                raw = [detect(im, face, pose, up, pad) for im in imgs]
                if cf:
                    cf.parent.mkdir(parents=True, exist_ok=True)
                    np.savez(cf, **{f"{c}{i}": d for i, r in enumerate(raw) for c, d in zip("fp", r)})
            h, w = imgs[0].shape[:2]
            det, sure = zip(*[heads(fd, pd, w, h, kind == "pano") for fd, pd in raw])
            q = 88 if kind == "pano" else 92
            out = []
            for i, im in enumerate(imgs):
                boxes = [b for j in range(max(0, i - HOLD), min(len(det), i + HOLD + 1)) for b in det[j]]
                if not sure[i]:  # no face / clear head in this frame (e.g. a face filling the close-up): blur it all
                    k = int(max(w, h) / 6) | 1
                    im = cv2.GaussianBlur(cv2.resize(cv2.resize(im, (w // 64, h // 64), interpolation=cv2.INTER_AREA),
                                                     (w, h)), (k, k), 0)
                out.append(cv2.imencode(".jpg", blur(im, boxes), [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes())
            f.write_bytes(b"".join(out))
            media[kind] = np.cumsum([0] + [len(j) for j in out]).tolist()
            none = sum(not x for x in sure)
            print(f"{sj.parent.name} {kind}: {len(imgs)} frames, {sum(map(len, det))} head boxes, "
                  f"{none} frames without a sure head (blurred whole)", flush=True)
            if a.check:  # every 3rd frame: each person (conf >= 0.3) upper body, 128 px high, after blurring
                Path(a.check).mkdir(parents=True, exist_ok=True)
                tiles = []
                for i in range(0, len(out), 3):
                    im = cv2.imdecode(np.frombuffer(out[i], np.uint8), cv2.IMREAD_COLOR)
                    for b in raw[i][1]:
                        if b[4] < 0.3 or b[2] - b[0] > 0.4 * w:
                            continue
                        x0, y0, x1, y1 = b[:4]
                        y1 = y0 + 0.55 * (y1 - y0)
                        x0, x1 = (x0 + x1) / 2 - (y1 - y0) / 2, (x0 + x1) / 2 + (y1 - y0) / 2
                        c = im[max(0, int(y0)):int(y1) + 1, max(0, int(x0)):min(w, int(x1) + 1)]
                        if c.size:
                            c = cv2.resize(c, (round(128 * c.shape[1] / c.shape[0]), 128))
                            tiles.append(cv2.putText(c, str(i), (2, 12), 0, 0.4, (0, 0, 255), 1))
                rows, row = [], []
                for t in tiles:
                    if sum(x.shape[1] for x in row) + t.shape[1] > 1600:
                        rows.append(np.concatenate(row + [np.zeros((128, 1600 - sum(x.shape[1] for x in row), 3), np.uint8)], 1))
                        row = []
                    row.append(t[:, :1600])
                if row:
                    rows.append(np.concatenate(row + [np.zeros((128, 1600 - sum(x.shape[1] for x in row), 3), np.uint8)], 1))
                for j in range(0, len(rows), 8):
                    cv2.imwrite(str(Path(a.check) / f"{sj.parent.name}_{kind}_{j // 8}.jpg"), np.concatenate(rows[j:j + 8]))
        media["blurred"] = True
        sc["media"] = media
        sj.write_text(json.dumps(sc, separators=(",", ":")))


if __name__ == "__main__":
    main()
