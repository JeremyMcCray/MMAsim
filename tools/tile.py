import sys, os
from PIL import Image
d = sys.argv[1]
for name in sorted(os.listdir(d)):
    sub = os.path.join(d, name)
    if not os.path.isdir(sub): continue
    files = [f for f in os.listdir(sub) if f.endswith('.png')]
    rows = 1 + max(int(f.split('-')[0]) for f in files); cols = 1 + max(int(f.split('-')[1][:-4]) for f in files)
    im0 = Image.open(os.path.join(sub, files[0])); W, H = im0.size
    out = Image.new('RGB', (W * cols, H * rows))
    for f in files:
        r, c = int(f.split('-')[0]), int(f.split('-')[1][:-4])
        out.paste(Image.open(os.path.join(sub, f)), (c * W, r * H))
    out.save(os.path.join(d, name + '.png')); print(name, out.size)
