from __future__ import annotations

import argparse
import os
from pathlib import Path


MODEL_ALIASES = {
    "paraformer-zh": "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "fsmn-vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "ct-punc": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Preload FunASR ModelScope models into the Docker image/cache.")
    parser.add_argument(
        "--cache-dir",
        default=os.environ.get("MODELSCOPE_CACHE", ""),
        help="ModelScope cache directory. Defaults to MODELSCOPE_CACHE.",
    )
    parser.add_argument(
        "models",
        nargs="*",
        default=[
            os.environ.get("FUNASR_MODEL", "paraformer-zh"),
            os.environ.get("FUNASR_VAD_MODEL", "fsmn-vad"),
            os.environ.get("FUNASR_PUNC_MODEL", "ct-punc"),
        ],
        help="ModelScope model ids or known aliases.",
    )
    args = parser.parse_args()

    from modelscope import snapshot_download

    cache_dir = str(Path(args.cache_dir).resolve()) if args.cache_dir else None
    if cache_dir:
        Path(cache_dir).mkdir(parents=True, exist_ok=True)
        os.environ["MODELSCOPE_CACHE"] = cache_dir

    model_ids = []
    for model in args.models:
        model_id = MODEL_ALIASES.get(str(model).strip(), str(model).strip())
        if model_id and model_id not in model_ids:
            model_ids.append(model_id)

    for model_id in model_ids:
        print(f"Preloading FunASR model: {model_id}")
        snapshot_download(model_id, cache_dir=cache_dir)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
