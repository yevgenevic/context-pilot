"""Create the offline distributable from an allowlist, with its executable bit intact."""
from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
fixed = ("package.json", "README.md", "scripts/release_zip.py", "scripts/release-package.mjs",
         "ui/package.json", "ui/package-lock.json",
         "ui/tsconfig.json", "ui/dashboard.html", "ui/dist/dashboard.js", "ui/dist/dashboard.css")
files = {root / name for name in fixed}
for pattern in ("src/*.ts", "test/*.mjs", "test/support/*.mjs", "ui/*.ts", "ui/*.tsx",
                "ui/*.css", "ui/components/**/*.tsx"):
    files.update(root.glob(pattern))
destination = root / "site/download/context-pilot.zip"
destination.parent.mkdir(parents=True, exist_ok=True)
with NamedTemporaryFile(dir=destination.parent, delete=False) as tmp:
    archive = Path(tmp.name)
try:
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as out:
        for file in sorted(files):
            name = file.relative_to(root).as_posix()
            info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if name == "src/pilot.ts" else 0o100644) << 16
            out.writestr(info, file.read_bytes(), compress_type=ZIP_DEFLATED)
    with ZipFile(archive) as out:
        for name in out.namelist():
            if out.read(name) != (root / name).read_bytes():
                raise ValueError(f"Archive mismatch: {name}")
    archive.chmod(0o644)
    archive.replace(destination)
    print(f"{destination.name}: {len(files)} files, {destination.stat().st_size} bytes")
finally:
    archive.unlink(missing_ok=True)
