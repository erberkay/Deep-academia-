#!/bin/bash
# edge_strips.sh <face.jpg> <outdir>: the four 1-px border rows/columns of a cube face, resampled to 128 RGB samples
f="$1"; o="$2"; n=$(basename "$f" .jpg)
ffmpeg -loglevel error -y -i "$f" -filter_complex "[0]split=4[a][b][c][d];[a]crop=iw:2:0:0,scale=128:1:flags=area[t];[b]crop=iw:2:0:ih-2,scale=128:1:flags=area[bm];[c]crop=2:ih:0:0,scale=1:128:flags=area[l];[d]crop=2:ih:iw-2:0,scale=1:128:flags=area[r]" \
  -map "[t]" -f rawvideo -pix_fmt rgb24 "$o/$n.T" -map "[bm]" -f rawvideo -pix_fmt rgb24 "$o/$n.B" \
  -map "[l]" -f rawvideo -pix_fmt rgb24 "$o/$n.L" -map "[r]" -f rawvideo -pix_fmt rgb24 "$o/$n.R"
