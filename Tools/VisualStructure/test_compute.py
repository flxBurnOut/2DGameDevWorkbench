"""Numerical regression tests in the optional runtime, never SpritePipeline.

Run: work/visual-structure-runtime/venv/bin/python -m unittest discover -s Tools/VisualStructure
No SAM checkpoint, network or paid provider required.
"""
import unittest

import torch
import torch.nn.functional as F

from compute import inference_context


@unittest.skipUnless(torch.backends.mps.is_available(), 'Apple GPU unavailable')
class MPSComputeTests(unittest.TestCase):
    def test_attention_preserves_keys_masks_and_restores_after_error(self):
        torch.manual_seed(17)
        # More than 4,194,304 score elements forces multiple query chunks.
        q, k, v = [torch.randn(shape) for shape in [(2, 2, 73, 32), (2, 2, 17000, 32), (2, 2, 17000, 16)]]
        original = F.scaled_dot_product_attention
        for kind in ['none', 'boolean', 'additive']:
            mask = None if kind == 'none' else torch.ones((73, 17000), dtype=torch.bool)
            if mask is not None:
                mask[0] = False
                mask[:, 2::3] = False
                if kind == 'additive':
                    mask = torch.zeros(mask.shape).masked_fill(~mask, -float('inf'))
            expected = original(q, k, v, attn_mask=mask)
            with inference_context(torch, 'mps', torch.nn.Identity()):
                actual = F.scaled_dot_product_attention(q.to('mps'), k.to('mps'), v.to('mps'),
                    attn_mask=mask.to('mps') if mask is not None else None).cpu()
            torch.testing.assert_close(actual, expected, atol=2e-5, rtol=2e-4)
            self.assertIs(F.scaled_dot_product_attention, original)
        with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
            with inference_context(torch, 'mps', torch.nn.Identity()):
                raise RuntimeError('fixture failure')
        self.assertIs(F.scaled_dot_product_attention, original)

    def test_channels_last_pool_matches_cpu_without_cpu_fallback(self):
        torch.manual_seed(19)
        # This is the layout used by Hiera do_pool, including its qkv views.
        values = torch.randn(7, 14, 14, 192)
        nchw = values.permute(0, 3, 1, 2)
        model = torch.nn.Sequential(torch.nn.MaxPool2d(2, stride=2))
        expected = model(nchw)
        with inference_context(torch, 'mps', model):
            actual = model(nchw.to('mps')).cpu()
        torch.testing.assert_close(actual, expected, rtol=0, atol=0)
        self.assertEqual(len(model[0]._forward_pre_hooks), 0)


if __name__ == '__main__':
    unittest.main()
