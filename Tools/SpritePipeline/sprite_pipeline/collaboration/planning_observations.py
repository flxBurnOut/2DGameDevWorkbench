"""Reuse independent observations only when their evidence still applies."""

REFERENCE_CROP_FOLLOWUP = 'Requested reference view supplied. Complete or revise your proposal.'


def reference_appearance(work, role):
    return role == 'appearance' and work.spec.object_type == 'character'


def drawing_limits(work):
    limits = work.frame_budget or {}
    return {key: limits.get(key) for key in ('max_frames_per_request', 'max_total_frames', 'remaining_units')}


def reusable_observations(previous, work):
    if (previous.planning_format_version != work.planning_format_version
            or previous.reference_sha256 != work.reference_sha256
            or previous.character != work.character
            or previous.visual_structure != work.visual_structure
            or previous.planning_config != work.planning_config
            or previous.generation_policy_version != work.generation_policy_version):
        return []

    same_request = (previous.spec.model_dump(mode='json') == work.spec.model_dump(mode='json')
                    and drawing_limits(previous) == drawing_limits(work))
    reused = []
    for role in ('appearance', 'motion'):
        if not same_request and not reference_appearance(work, role):
            continue
        chain = [(position, message) for position, message in enumerate(previous.messages) if message['role'] == role]
        if not chain or chain[0][1].get('question'):
            continue
        position, message = chain[-1]
        response = message['response']
        if response['action'] != 'propose' or not response.get('findings'):
            continue
        expected_crop = None
        if len(chain) > 1:
            # A follow-up crop saw the full task and earlier peers. Reuse it
            # only with that same request and compatible peer observations.
            peers = {peer['role'] for peer in previous.messages[:position] if peer['role'] not in {role, 'validator'}}
            if not same_request or not peers <= {observation['role'] for observation in reused}:
                continue
            if any(earlier['response']['action'] != 'inspect_reference' or not earlier['response'].get('crop')
                   or next_turn.get('question') != REFERENCE_CROP_FOLLOWUP
                   for (_, earlier), (_, next_turn) in zip(chain, chain[1:])):
                continue
            expected_crop = chain[-2][1]['response']['crop']
        origin = message.get('reused_from')
        if origin is None:
            index = message.get('call')
            if not isinstance(index, int) or not 1 <= index <= len(previous.planning_calls):
                continue
            call = previous.planning_calls[index - 1]
            if call['role'] != role or call['state'] != 'completed' or call.get('crop') != expected_crop:
                continue
            origin = {'revision': previous.revision, 'call': index, 'request_id': call['request_id']}
        # Persist the new revision's evidence without adding a paid call or
        # making a prior call number index into the current revision's ledger.
        reused.append({'role': role, 'response': response, 'reused_from': origin})
    return reused
