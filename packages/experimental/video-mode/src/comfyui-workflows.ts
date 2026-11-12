/**
 * Bundled ComfyUI API-format workflows for the local provider. Each string
 * value of the form `{{name}}` is replaced at submission time; the node graphs
 * match the ComfyUI 0.38 native nodes for Wan 2.2 TI2V-5B and Z-Image Turbo.
 * @module @deepseek-ai/dsh-video-mode/comfyui-workflows
 */

/** One node of a ComfyUI API-format workflow. */
export interface ComfyWorkflowNode {
  /** Registered node class. */
  readonly class_type: string
  /** Node inputs; links appear as `[nodeId, outputIndex]`. */
  readonly inputs: Readonly<Record<string, unknown>>
}

/** A complete ComfyUI API-format workflow, keyed by node id. */
export type ComfyWorkflow = Readonly<Record<string, ComfyWorkflowNode>>

/**
 * Text-to-video graph for Wan 2.2 TI2V-5B. The sampler settings match the
 * ComfyUI template except for CFG: the template uses 5, but on Apple MPS the
 * batched negative branch corrupts colors, so this graph runs CFG 1, which
 * produces a clean frame and skips the negative prompt.
 */
export const WAN22_TI2V_WORKFLOW: ComfyWorkflow = {
  '1': {
    class_type: 'UNETLoader',
    inputs: { unet_name: '{{checkpoint}}', weight_dtype: 'default' },
  },
  '2': {
    class_type: 'ModelSamplingSD3',
    inputs: { model: ['1', 0], shift: 8 },
  },
  '3': {
    class_type: 'CLIPLoader',
    inputs: { clip_name: '{{text_encoder}}', type: 'wan' },
  },
  '4': {
    class_type: 'CLIPTextEncode',
    inputs: { clip: ['3', 0], text: '{{prompt}}' },
  },
  '5': {
    class_type: 'CLIPTextEncode',
    inputs: { clip: ['3', 0], text: '{{negative_prompt}}' },
  },
  '6': {
    class_type: 'VAELoader',
    inputs: { vae_name: '{{vae}}' },
  },
  '7': {
    class_type: 'Wan22ImageToVideoLatent',
    inputs: {
      vae: ['6', 0],
      width: '{{width}}',
      height: '{{height}}',
      length: '{{frames}}',
      batch_size: 1,
    },
  },
  '8': {
    class_type: 'KSampler',
    inputs: {
      model: ['2', 0],
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['7', 0],
      seed: '{{seed}}',
      steps: 20,
      cfg: 1,
      sampler_name: 'uni_pc',
      scheduler: 'simple',
      denoise: 1,
    },
  },
  '9': {
    class_type: 'VAEDecode',
    inputs: { samples: ['8', 0], vae: ['6', 0] },
  },
  '10': {
    class_type: 'CreateVideo',
    inputs: { images: ['9', 0], fps: '{{fps}}' },
  },
  '11': {
    class_type: 'SaveVideo',
    inputs: { video: ['10', 0], filename_prefix: '{{filename_prefix}}', format: 'mp4' },
  },
}

/** Text-to-image graph for Z-Image Turbo: 8 steps at CFG 1, AuraFlow shift 3. */
export const Z_IMAGE_WORKFLOW: ComfyWorkflow = {
  '28': {
    class_type: 'UNETLoader',
    inputs: { unet_name: '{{checkpoint}}', weight_dtype: 'default' },
  },
  '30': {
    class_type: 'CLIPLoader',
    inputs: { clip_name: '{{text_encoder}}', type: 'lumina2' },
  },
  '29': {
    class_type: 'VAELoader',
    inputs: { vae_name: '{{vae}}' },
  },
  '27': {
    class_type: 'CLIPTextEncode',
    inputs: { clip: ['30', 0], text: '{{prompt}}' },
  },
  '33': {
    class_type: 'ConditioningZeroOut',
    inputs: { conditioning: ['27', 0] },
  },
  '13': {
    class_type: 'EmptySD3LatentImage',
    inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 },
  },
  '11': {
    class_type: 'ModelSamplingAuraFlow',
    inputs: { model: ['28', 0], shift: 3 },
  },
  '3': {
    class_type: 'KSampler',
    inputs: {
      model: ['11', 0],
      positive: ['27', 0],
      negative: ['33', 0],
      latent_image: ['13', 0],
      seed: '{{seed}}',
      steps: 8,
      cfg: 1,
      sampler_name: 'res_multistep',
      scheduler: 'simple',
      denoise: 1,
    },
  },
  '8': {
    class_type: 'VAEDecode',
    inputs: { samples: ['3', 0], vae: ['29', 0] },
  },
  '9': {
    class_type: 'SaveImage',
    inputs: { images: ['8', 0], filename_prefix: '{{filename_prefix}}' },
  },
}
