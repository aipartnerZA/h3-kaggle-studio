"""H3 Pro nodes: flat-image reference conditioning + nothing else.

Why this exists: at the pinned ComfyUI (v0.34.0) MiniMaxH3ReferenceToVideo
exposes its image slots as an *autogrow* input. A direct /prompt submission
cannot fill that: the executor passes ref_image_N as keyword arguments while
execute() expects one `ref_images` dict, so every reference render dies with
"execute() got an unexpected keyword argument 'ref_image_1'". This node takes
explicit flat inputs and calls the built-in implementation, which is unchanged.

Image references only for now; video/audio references would need the same
treatment and are not wired.
"""


class H3ProReferenceToVideo:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {"vae": ("VAE",), "audio_vae": ("VAE",)}
        optional.update({"ref_image_%d" % i: ("IMAGE",) for i in range(1, 10)})
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True}),
                "width": ("INT", {"default": 736, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 416, "min": 32, "max": 8192, "step": 32}),
                "length": ("INT", {"default": 124, "min": 5, "max": 3600, "step": 1}),
                "ref_image_size": (["match", "max"], {"default": "match"}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "latent")
    FUNCTION = "apply"
    CATEGORY = "H3 Pro"

    def apply(self, clip, prompt, width, height, length, ref_image_size="match",
              vae=None, audio_vae=None, **images):
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo as Ref
        refs = {name: value for name, value in images.items() if value is not None}
        out = Ref.execute(clip=clip, prompt=prompt, width=width, height=height, length=length,
                          ref_image_size=ref_image_size, vae=vae, audio_vae=audio_vae,
                          ref_images=refs or None)
        return tuple(out.result)


NODE_CLASS_MAPPINGS = {"H3ProReferenceToVideo": H3ProReferenceToVideo}
NODE_DISPLAY_NAME_MAPPINGS = {"H3ProReferenceToVideo": "H3 Pro Reference to Video (flat refs)"}
