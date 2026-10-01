"""CHP plugin for ComfyUI — the reference implementation of ComfyUI Haminn Protocol.

Drop this folder into ``ComfyUI/custom_nodes/`` and restart ComfyUI.  Then:

1. Open the **HamDraw 配置 (Config)** node, set the password you want your
   drawing app to send, pick the checkpoint each category uses, fill in the
   three files the Qwen categories need, name the accelerator LoRA each of them
   runs with (and paste its sigma schedule), and Queue once.  Leaving the
   password empty turns authentication off.
2. Point the client at this machine's address; it discovers the rest through
   ``GET /chp/info``.

The plugin ships its own graphs for all five categories — ``fast``,
``inpaint``, ``upscale``, ``render`` and ``generate`` — so no API workflow
export is ever needed.  The contract is described in ``plans/chp-spec.md``.

``render`` 与 ``generate`` 是同一族模型的两条路：前者必须带一张参考图（定妆照、
姿势骨架、随手一张照片），后者是纯文生图、一个字节的输入图都不带。客户端**从规则
本身**就能读出这件事（``rules[].signature`` 里有没有 ``ref``），不必试探。

CHP is the protocol; ``hamdraw_chp`` is one implementation of it.  That is why
the package, the ``/chp`` root and ``hamdraw_settings.json`` keep their names
while the prose says "CHP": the protocol was renamed, not the deployment.
"""

from __future__ import annotations

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import server as server_module

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

ROUTES_REGISTERED = server_module.register_routes()

if not ROUTES_REGISTERED:
    print("[CHP] HTTP 路由未注册：ComfyUI 服务实例还不可用，客户端将无法连接。")
