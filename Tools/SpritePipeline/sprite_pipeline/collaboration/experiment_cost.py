"""Count each recorded provider attempt once, even when its price is unknown."""
import math


def amount(usage, field):
    value = usage.get(field)
    if type(value) in (int, float) and 0 <= value <= 2**53 and math.isfinite(value):
        return value
    return None


def priced_amounts(usages):
    for usage in usages:
        usd = amount(usage, 'cost_usd')
        if usd is None and usage.get('type') in (None, 'usd'):
            usd = amount(usage, 'usd')
        if usd is not None:
            yield usd


def drawing_cost(usages):
    costs = list(priced_amounts(usages))
    units = [amount(usage, 'generations' if usage.get('type') in (None, 'generations') and 'units' not in usage else 'units')
             for usage in usages]
    return {'attempts': len(usages), 'priced_calls': len(costs), 'unpriced_calls': len(usages) - len(costs),
            'known_usd': sum(costs), 'known_units': sum(unit for unit in units if unit is not None),
            'total_usd': sum(costs) if len(costs) == len(usages) else None}
