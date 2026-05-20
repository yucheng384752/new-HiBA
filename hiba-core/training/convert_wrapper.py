"""
Wrapper: patches gguf.MODEL_ARCH with values missing from gguf 0.18.0,
then runs _convert_hf_to_gguf.py as __main__.
"""
import sys
import gguf

MISSING_ARCHES = ["GEMMA4", "DEEPSEEK2OCR", "HUNYUAN_VL", "MISTRAL4"]

_max_val = max(e.value for e in gguf.MODEL_ARCH)
for _i, _name in enumerate(MISSING_ARCHES):
    if not hasattr(gguf.MODEL_ARCH, _name):
        _v = _max_val + _i + 1
        _m = int.__new__(gguf.MODEL_ARCH, _v)
        _m._name_ = _name
        _m._value_ = _v
        gguf.MODEL_ARCH._member_map_[_name] = _m
        gguf.MODEL_ARCH._value2member_map_[_v] = _m
        type.__setattr__(gguf.MODEL_ARCH, _name, _m)
        # stub entries so dicts don't KeyError at import time
        gguf.MODEL_ARCH_NAMES[_m] = _name.lower().replace("_", "-")
        gguf.MODEL_TENSORS[_m] = {}

import os
_script = os.path.join(os.path.dirname(__file__), "_convert_hf_to_gguf.py")
_code = open(_script, encoding="utf-8").read()
_globals = {"__name__": "__main__", "__file__": _script}
exec(compile(_code, _script, "exec"), _globals)
