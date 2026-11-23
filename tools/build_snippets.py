#!/usr/bin/env python3
"""Bake 3D snippets of the trashbot-data-extended repo into static files for the standalone viewer (web/).

Not needed to run the viewer: it documents how web/snippets/ was made. Run from the source repo's `snippets3d`
conda env (numpy, scipy, torch, cv2, pyrender), with the source repo checkout (--src) and its viewer exports
(--exports); snippets = those whose notes (data/studies/snippets3d/<name>/notes.txt) contain the word "export".

Per snippet, web/snippets/<id>/:
- scene.json   render.Track of the source viewer (serve.load: robot path / heading, pelvis track, ground disc, camera
               plans), the bodies (`models`: id, label, V, faces = smpl | smplx), their pelvis ground tracks (`paths`) and
               pedestrian point of view (`pov`: eye position (T, 3) and facing yaw (T,), from face vertices, smoothed).
               WHAM: the snapped body only (pose from WHAM, pelvis on the pipeline track).
- body_<model>.bin  int16 (T, V, 3) little endian, vertex - (path x, path y, 0) in 0.1 mm (prerendered SMPL / SMPL-X
               meshes: no body model or licence needed to view them).
- cloud.bin    scene point cloud as filtered in the source viewer: points within --radius m of the robot-centric origin,
               the snippet's hand mask removed (scene_mask.npz) and its alignment applied (scene_adjust.json);
               float32 xyz (N, 3) then uint8 rgb (N, 3).
- crop.jpgs / pano.jpgs (--with-video only: real images of people, then run blur_faces.py): JPEG frames concatenated,
               offsets in scene.json.
Shared: web/snippets/index.json (list), faces_smpl.bin / faces_smplx.bin (uint32 (F, 3)), web/assets/ robot glTF.
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d

BOROUGH = {"bronx": "Bronx", "brooklyn": "Brooklyn", "manhattan": "Manhattan", "queens": "Queens",
           "staten": "Staten Island"}
MODELS = {"motionbert": ("MotionBERT", "smpl"), "wham": ("WHAM", "smpl"), "kimodo": ("Kimodo", "smplx")}
FACE = {"smpl": dict(reye=6260, leye=2800, rear=4071, lear=583),  # SMPL vertex ids (smplx vertex_ids.py)
        "smplx": dict(reye=9929, leye=9448, rear=616, lear=6)}
Q = 1e-4  # body vertex quantum (m)
SCENE_KEYS = ["fps", "T", "t_rel", "robot", "robot_heading", "pelvis", "mid", "follow_p", "follow_hd", "center", "gc",
              "gr", "defaults", "defaults_track", "dist", "speed", "title", "subtitle", "colors", "box"]


def pov(verts, kind, fps):
    """Eye midpoint (T, 3) and facing yaw (T,) rad (ear midpoint -> eyes, horizontal), smoothed over ~0.15 / 0.3 s."""
    f = FACE[kind]
    eye = (verts[:, f["reye"]] + verts[:, f["leye"]]) / 2
    fwd = eye - (verts[:, f["rear"]] + verts[:, f["lear"]]) / 2
    yaw = np.unwrap(np.arctan2(fwd[:, 1], fwd[:, 0]))
    return gaussian_filter1d(eye, 0.15 * fps, axis=0, mode="nearest"), gaussian_filter1d(yaw, 0.3 * fps, mode="nearest")


def snippet_id(seg):
    return f"{seg['area']}_{seg['date']}_{seg['robot']}_{seg['video']}_p{seg['person']}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--src", default=str(Path.home() / "Projects/IRL-Projects/trashbot-data-extended"))
    ap.add_argument("--exports", default="/media/raphael/hucedisk/trashbot-data-store/trashbot_output/viewer_exports")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "web"))
    ap.add_argument("--radius", type=float, default=85.0, help="scene cloud radius (m)")
    ap.add_argument("--zmax", type=float, default=26.2, help="scene cloud max height (m)")
    ap.add_argument("--zmax-area", nargs="*", default=["bronx_little_italy=3"],
                    help="per-area max height, <area>=<m> (Bronx: tree canopy over the robot, as the paper snapshots)")
    ap.add_argument("--note", default="export", help="word the snippet notes must contain")
    ap.add_argument("--with-video", action="store_true", help="also ship the body crop / 360 frames (real images: run blur_faces.py next)")
    a = ap.parse_args()

    src = Path(a.src)
    sys.path.insert(0, str(src / "studies/snippets3d"))
    import serve
    import scene_ref
    serve.EXPORTS = a.exports
    root = src / "data/studies/snippets3d"
    out = Path(a.out)
    names = sorted(p.parent.name for p in root.glob("*/notes.txt")
                   if re.search(rf"\b{a.note}\b", p.read_text(), re.I))
    snip_dir = out / "snippets"
    if snip_dir.exists():
        shutil.rmtree(snip_dir)
    snip_dir.mkdir(parents=True)
    (out / "assets").mkdir(exist_ok=True)
    shutil.copy(root / "assets/trash_barrel_120L/trash_barrel_120L.glb", out / "assets/trash_barrel_120L.glb")
    faces, index = {}, []
    for name in names:
        ex = serve.find_export(name)
        seg = serve.seg_info(ex)
        sid = snippet_id(seg)
        d = snip_dir / sid
        d.mkdir()
        sc = serve.load(name)[0]
        scene = {k: sc[k] for k in SCENE_KEYS}
        b0, *pl = seg["area"].split("_")
        scene.update(id=sid, models=[], paths={}, pov={}, robot_model="assets/trash_barrel_120L.glb",
                     title=f"{' '.join(pl).title()} ({BOROUGH.get(b0, b0.title())})  ·  {seg['date']}")
        T = sc["T"]
        for m, (label, kind) in MODELS.items():
            b = serve.body(name, m)
            if b is None:
                print(f"  {sid}: no {m} body", flush=True)
                continue
            v = np.frombuffer(b[0], "<f4").reshape(T, -1, 3)
            path = np.round(np.asarray(b[1], float), 4)
            off = v - np.c_[path, np.zeros(T)][:, None]
            q = np.round(off / Q)
            if np.abs(q).max() >= 32767:
                raise ValueError(f"{sid} {m}: vertex offset beyond int16 range")
            (d / f"body_{m}.bin").write_bytes(q.astype("<i2").tobytes())
            faces.setdefault(kind, np.frombuffer(b[2], "<u4"))
            eye, yaw = pov(v, kind, sc["fps"])
            scene["models"].append(dict(id=m, label=label, V=int(v.shape[1]), faces=kind))
            scene["paths"][m] = path.tolist()
            scene["pov"][m] = dict(eye=np.round(eye, 4).tolist(), yaw=np.round(yaw, 4).tolist())
        ref = serve.ref_of(name)
        xyz, rgb, idx = scene_ref.load_cloud(ref, a.radius)
        keep = ~np.isin(idx, serve.mask_get(name))
        M = scene_ref.adjust_matrix(serve.adjust_get(name))
        xyz = (xyz[keep].astype(np.float64) @ M[:3, :3].T + M[:3, 3]).astype("<f4")
        rgb = rgb[keep]
        zmax = dict(z.split("=") for z in a.zmax_area).get(seg["area"], a.zmax)
        low = xyz[:, 2] <= float(zmax)
        xyz, rgb = xyz[low], rgb[low]
        (d / "cloud.bin").write_bytes(xyz.tobytes() + rgb.astype("u1").tobytes())
        scene["cloud"] = dict(n=len(xyz), radius=a.radius, zmax=float(zmax))
        scene["media"] = {}
        if a.with_video:
            for kind, file in (("crop", "crop_body.mp4"), ("pano", "pano_preview.mp4")):
                if (ex / file).exists():
                    jp = serve.stills(name, kind)
                    (d / f"{kind}.jpgs").write_bytes(b"".join(jp))
                    scene["media"][kind] = np.cumsum([0] + [len(j) for j in jp]).tolist()
        (d / "scene.json").write_text(json.dumps(scene, separators=(",", ":")))
        index.append(dict(id=sid, title=scene["title"], subtitle=sc["subtitle"], T=T, fps=sc["fps"],
                          models=[m["id"] for m in scene["models"]], points=len(xyz), source=name,
                          **{k: seg[k] for k in ("area", "date", "robot", "video", "person", "t0", "dur")}))
        mb = sum(f.stat().st_size for f in d.iterdir()) / 1e6
        print(f"{sid}: {T} frames, bodies {[m['id'] for m in scene['models']]}, {len(xyz):,} points "
              f"({(~keep).sum():,} masked), {mb:.0f} MB", flush=True)
    for kind, f in faces.items():
        (snip_dir / f"faces_{kind}.bin").write_bytes(f.astype("<u4").tobytes())
    index.sort(key=lambda e: (e["date"], e["area"], e["t0"]))
    (snip_dir / "index.json").write_text(json.dumps(index, indent=1))
    print(f"{len(index)} snippets -> {snip_dir}")


if __name__ == "__main__":
    main()
