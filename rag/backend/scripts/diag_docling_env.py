"""Diagnostic: report Docling/Torch/CUDA environment for tuning decisions."""
import importlib.metadata as md
import platform
import sys


def ver(pkg: str) -> str:
    try:
        return md.version(pkg)
    except Exception as exc:  # noqa: BLE001
        return f"<not installed: {exc}>"


print("=== Python / OS ===")
print("python:", sys.version.split()[0], platform.platform())

print("\n=== Key package versions ===")
for pkg in [
    "docling",
    "docling-core",
    "docling-ibm-models",
    "docling-parse",
    "torch",
    "torchvision",
    "rapidocr-onnxruntime",
    "rapidocr_onnxruntime",
    "onnxruntime",
    "onnxruntime-gpu",
    "easyocr",
    "opencv-python-headless",
]:
    print(f"  {pkg}: {ver(pkg)}")

print("\n=== Torch / CUDA ===")
try:
    import torch

    print("  torch:", torch.__version__)
    print("  cuda available:", torch.cuda.is_available())
    print("  cuda build version:", torch.version.cuda)
    print("  cudnn:", torch.backends.cudnn.version() if torch.cuda.is_available() else "n/a")
    if torch.cuda.is_available():
        for i in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(i)
            print(
                f"  gpu[{i}]: {props.name} | "
                f"sm_{props.major}{props.minor} | "
                f"{props.total_memory / 1024**3:.1f} GiB | "
                f"{props.multi_processor_count} SMs"
            )
        print("  bf16 supported:", torch.cuda.is_bf16_supported())
except Exception as exc:  # noqa: BLE001
    print("  torch import failed:", exc)

print("\n=== onnxruntime providers ===")
try:
    import onnxruntime as ort

    print("  ort:", ort.__version__)
    print("  providers:", ort.get_available_providers())
except Exception as exc:  # noqa: BLE001
    print("  onnxruntime import failed:", exc)

print("\n=== CPU ===")
try:
    print("  logical cpus:", __import__("os").cpu_count())
except Exception as exc:  # noqa: BLE001
    print("  cpu detect failed:", exc)
