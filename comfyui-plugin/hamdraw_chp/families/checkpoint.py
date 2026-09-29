"""The checkpoint family: one ``CheckpointLoaderSimple`` carries everything.

This is the img2img family.  It is ordinary latent img2img — encode the
reference, sample it with a denoise that the reference-strength knob sets — so
its ``ref_strength`` mechanism is "how much of the encoded reference latent is
kept": ``denoise = 1 - ref_strength``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import graph

#: Model roles this family needs configured.
ROLES: tuple[str, ...] = ("checkpoint",)

#: Extension keys this family understands, out of the caller's ``ext_params``.
#: The dispatcher hands it exactly these and nothing else.  ``step`` is this
#: implementation's own key: the spec defines no field inside ``ext_params``, so
#: the enumeration and the default live in the category table, not in the
#: contract.
EXT: tuple[str, ...] = ("step", "negative_prompt")

REFERENCE_FLOOR = 0.05
REFERENCE_CEILING = 0.95
DENOISE_MINIMUM = 0.05
DENOISE_MAXIMUM = 1.0

#: Upscaling encodes the reference at its own resolution up to this cap, and only
#: grows the latent above it.  The cap is what keeps a 2048 px job from needing
#: roughly four times the memory of a 1024 px one.  It is deliberately *not* 512:
#: encoding at 512 and growing the latent afterwards put the reference through a
#: lossy round trip before the sampler ever saw it, which is why a "render" came
#: out soft and partly re-invented instead of sharper than the canvas it came from.
ENCODE_MAX = 1024


def reference_canvas(size: Any) -> tuple[int, int]:
    """The canvas node 3 scales the reference into before the sampler sees it.

    That node takes a **hard** frame (``crop: "disabled"``) and therefore
    stretches whatever it is handed, so this pair and the shape of the picture
    the client uploaded have to agree.  It lives here, next to :data:`ENCODE_MAX`
    and called by :func:`build` itself, so the guard below and the graph can
    never disagree about what the target is — a second copy of ``min(edge,
    ENCODE_MAX)`` at the call site is exactly how that drifts.

    Note the cap can change the shape, not just the scale: a 2048 × 1024 job is
    encoded at 1024 × 1024.  A client cannot assume its own aspect survives.
    """
    return (min(int(size[0]), ENCODE_MAX), min(int(size[1]), ENCODE_MAX))


def reference_fits(reference: Any, size: Any) -> bool:
    """Is the uploaded picture already the shape node 3 will scale it to?

    Compared by cross-multiplication rather than as a float ratio, so 576 × 384
    against a 512 px job is decided exactly instead of by an epsilon.

    An unmeasurable or absent reference passes.  This is a tripwire for a client
    that sends the wrong shape — the failure it catches is invisible in the
    result, because the canvas comes back right and only the picture inside it is
    squashed — not a gate that can stop a job because a file moved.
    """
    if not reference:
        return True
    try:
        width, height = int(reference[0]), int(reference[1])
    except (TypeError, ValueError, IndexError, KeyError):
        return True
    if width <= 0 or height <= 0:
        return True
    target_width, target_height = reference_canvas(size)
    return width * target_height == height * target_width


def reference_pixels(image: Any) -> tuple[int, int] | None:
    """The pixel size of a reference sitting in ComfyUI's input folder.

    Best effort by design, and the one piece of IO in this module: the offline
    contract tests import this package with ``folder_paths`` stubbed and no
    Pillow, and a reference that cannot be measured must not fail a job.  Named
    at module level so a test can replace it and drive the guard without a
    filesystem.
    """
    name = str(image or "").strip()
    if not name:
        return None
    try:
        import folder_paths
        from PIL import Image
    except Exception:
        return None
    try:
        path = Path(folder_paths.get_annotated_filepath(name))
        if not path.is_file():
            return None
        with Image.open(path) as opened:
            return (int(opened.width), int(opened.height))
    except Exception:
        return None


def denoise_from_reference(ref_strength: float) -> float:
    """How far the sampler may move away from the encoded reference.

    The single weight lever: the client says how tightly to follow the
    reference, and the family turns that into a denoise floor.
    """
    value = 1.0 - max(0.0, min(1.0, float(ref_strength)))
    return max(DENOISE_MINIMUM, min(DENOISE_MAXIMUM, value))


def build(
    *,
    models: dict[str, Any],
    image: str,
    masked: bool = False,
    mask: str = "",
    prompt: str = "",
    negative_prompt: str = "",
    seed: int = 0,
    # 扩展参数，所以带默认值：真正的默认值按类别取自类别表（fast 8 / inpaint 6 …），
    # 由 dispatcher 交进来；这个数是直接调用本函数时的兜底。
    step: int = 8,
    size: tuple[int, int],
    sampling: dict[str, Any],
    ref_strength: float,
    filename_prefix: str = "hamdraw/hamdraw",
) -> dict[str, Any]:
    checkpoint = str((models or {}).get("checkpoint") or "").strip()
    if not checkpoint:
        raise ValueError("no_model")

    width, height = int(size[0]), int(size[1])
    # The cap is a ceiling, not a target, and only the upscale category ever
    # reaches it: fast and inpaint cap their own long edge at 768 and their
    # pixels at 262144 (512²), so for them `encode` is always exactly the job
    # canvas, node 12 below never appears, and the sampler starts from the real
    # picture.  Upscale goes to 2048², and there the reference is encoded at
    # 1024 and the latent is grown afterwards — deliberately, because encoding a
    # 2048 px job directly costs about four times the memory of a 1024 px one.
    encode = reference_canvas((width, height))
    # A reference that is not the shape of the frame node 3 scales it into would
    # be stretched, and nothing downstream can tell: the job comes back on the
    # right canvas with a squashed picture in it.  Refusing is the only honest
    # answer — the client owns how its square canvas maps into a job frame, and
    # this side cannot guess that from a finished bitmap.
    if not reference_fits(reference_pixels(image), (width, height)):
        raise ValueError("stretched_reference")

    graph_nodes: dict[str, Any] = {
        "1": graph.checkpoint_node(checkpoint),
        "2": graph.load_image(image, "HamDraw reference"),
        "3": graph.scale(["2", 0], encode[0], encode[1]),
        "5": graph.text_encode(prompt, ["1", 1], "HamDraw prompt"),
        "6": graph.text_encode(negative_prompt, ["1", 1], "HamDraw negative prompt"),
    }

    if masked:
        graph_nodes["10"] = graph.load_image(mask, "HamDraw mask")
        graph_nodes["11"] = {"class_type": "ImageToMask",
                             "inputs": {"image": ["10", 0], "channel": "red"}}
        #: Do not grey the reference at all. Greying — either the rounded kind
        #: VAEEncodeForInpaint does or a continuous blend with mid-grey — hands
        #: the sampler a flat grey patch to paint on, and a plain checkpoint
        #: answers in kind: measured on a real redraw, 49.5% of the pixels
        #: inside the mask came back as low-saturation mid-grey against 0.1%
        #: outside it, which is the grey halo around every repainted object.
        #: Encoding the untouched reference instead keeps the original context
        #: under the mask, so the model extends the picture rather than filling
        #: a blank; the sampler still rebuilds the masked area from noise
        #: because SetLatentNoiseMask is attached below, and the unmasked part
        #: is carried through every step.
        graph_nodes["4"] = {"class_type": "VAEEncode",
                            "inputs": {"pixels": ["3", 0], "vae": ["1", 2]}}
    else:
        graph_nodes["4"] = {"class_type": "VAEEncode",
                            "inputs": {"pixels": ["3", 0], "vae": ["1", 2]}}

    latent: list[Any] = ["4", 0]
    if encode != (width, height):
        graph_nodes["12"] = graph.latent_upscale(["4", 0], width, height)
        latent = ["12", 0]

    if masked:
        # The sampler needs the mask so the unmasked area is carried through
        #: every step — and this node reads continuous values, so the client's
        #: feather survives as a real ramp instead of the 0/1 stencil that
        #: VAEEncodeForInpaint would have built from it.
        graph_nodes["13"] = {"class_type": "SetLatentNoiseMask",
                             "inputs": {"samples": latent, "mask": ["11", 0]}}
        latent = ["13", 0]

    graph_nodes["7"] = graph.sampler(["1", 0], ["5", 0], ["6", 0], latent, seed, step,
                                     sampling, denoise_from_reference(ref_strength))
    graph_nodes["8"] = {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["1", 2]}}
    graph_nodes["9"] = graph.output_node(["8", 0], filename_prefix)
    return graph_nodes


__all__ = ["ENCODE_MAX", "ROLES", "build", "denoise_from_reference", "reference_canvas", "reference_fits", "reference_pixels"]
