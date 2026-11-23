# Trashbot 3D snippets viewer

Standalone web viewer of anonymous 3D re-enactments of public encounters with a trash barrel robot in New York City's
five boroughs (HRI'27 video submission). Each snippet shows one person as a body mesh moving around the robot, in a
point cloud of the site. Everything is prerendered, so you need no body model, licence or GPU.

## Data
The repo holds one snippet (Little Italy, Bronx), without video frames. For all six snippets and their close-up and
360° frames (faces blurred), download
[`snippets.zip`](https://huggingface.co/datasets/rlorlou/trashbot-hri-3d-viewer-snippets/resolve/main/snippets.zip)
(330 MB, [dataset page](https://huggingface.co/datasets/rlorlou/trashbot-hri-3d-viewer-snippets)), unzip it and move
its `snippets/` folder into `web/`, replacing `web/snippets/`.

## Run
Any static HTTP server on `web/`. Opening `index.html` directly from disk does not work. For example:
```bash
python3 -m http.server -d web 8000     
# Open http://localhost:8000
```

## Use
- **Snippets** (right): search box, area (borough / place) and date filters.
- **Play** (play/pause/move in time using slider, space bar or ←/→). Drag to orbit, wheel to zoom.
- **Camera**: presets are `side`, `wide`, `robot`, `follow person`, `top`, `pedestrian POV`
- **Person**: choose the body model (WHAM - default, MotionBERT, Kimodo), path drawing options. 
- **Robot**: path drawing option, distance rings. 
- **Scene point cloud**: show or hide, set point size, opacity, colour.
- **Scene & light**: advanced scene rendering options
- **Overlay** : close-up and 360 video display, if assets are present (faces are blurred).
- **Export…** (top right): MP4 of the whole clip or PNG of the current frame, as you see it (1920 × 1080).

## Files
```
web/
  index.html            page layout, export dialog
  viewer.js             viewer (three.js): loading, cameras, rendering, GUI, export
  assets/               robot model (trash_barrel_120L.glb)
  snippets/             data (one snippet included in the repo, see Data to download the others)
    index.json          snippet list (id, place, date, robot, video, person, frames)
    faces_smpl.bin      mesh triangles of the SMPL / SMPL-X bodies (uint32)
    faces_smplx.bin
    <id>/scene.json     robot and person tracks, cameras, pedestrian eye / facing per body
    <id>/body_*.bin     prerendered body meshes per frame (motionbert, wham, kimodo)
    <id>/cloud.bin      filtered scene point cloud (float32 xyz, uint8 rgb)
    <id>/crop.jpgs      close-up frames, faces blurred
    <id>/pano.jpgs      full frames, faces blurred
  vendor/               three.js 0.160, lil-gui 0.19.2, mp4-muxer 5.1.3
tools/                  how web/snippets/ was made from the research pipeline (not needed to view):
  build_snippets.py     bake the snippets (run with --with-video for the frames)
  blur_faces.py         then blur every face in the frames (YOLO face + pose detectors)
```

<details>
<summary>Licences and credits</summary>

The bodies are rendered in advance because the models that produce them need an access request and are covered by
their own licences: [SMPL](https://smpl.is.tue.mpg.de/modellicense.html) (MotionBERT and WHAM bodies),
[SMPL-X](https://smpl-x.is.tue.mpg.de/bodylicense.html) and the
[NVIDIA Internal Scientific Research and Development Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/)
(Kimodo). The scene point clouds come from PanoVGGT, the robot trajectories from 360DVO.

```bibtex
@article{SMPL:2015,
  author    = {Loper, Matthew and Mahmood, Naureen and Romero, Javier and Pons-Moll, Gerard and Black, Michael J.},
  title     = {{SMPL}: A Skinned Multi-Person Linear Model},
  journal   = {ACM Trans. Graphics (Proc. SIGGRAPH Asia)},
  volume    = {34},
  number    = {6},
  pages     = {248:1--248:16},
  month     = oct,
  year      = {2015},
  publisher = {ACM}
}
@inproceedings{SMPL-X:2019,
  title     = {Expressive Body Capture: {3D} Hands, Face, and Body from a Single Image},
  author    = {Pavlakos, Georgios and Choutas, Vasileios and Ghorbani, Nima and Bolkart, Timo and Osman, Ahmed A. A. and Tzionas, Dimitrios and Black, Michael J.},
  booktitle = {Proceedings IEEE Conf. on Computer Vision and Pattern Recognition (CVPR)},
  pages     = {10975--10985},
  year      = {2019}
}
@article{guo2026panovggt,
  title   = {PanoVGGT: Feed-Forward 3D Reconstruction from Panoramic Imagery},
  author  = {Guo, Yijing and Chao, Mengjun and Wang, Luo and Zhao, Tianyang and Dai, Haizhao and Zhang, Yingliang and Yu, Jingyi and Shi, Yujiao},
  journal = {arXiv preprint arXiv:2603.17571},
  year    = {2026}
}
@article{11358682,
  author  = {Guo, Xiaopeng and Xu, Yinzhe and Huang, Huajian and Yeung, Sai-Kit},
  title   = {360DVO: Deep Visual Odometry for Monocular 360-Degree Camera},
  journal = {IEEE Robotics and Automation Letters},
  volume  = {11},
  number  = {3},
  pages   = {3079--3086},
  year    = {2026},
  doi     = {10.1109/LRA.2026.3655280}
}
```
</details>
