import argparse
import json
from pathlib import Path
import sys
from . import InputError, Recipe, convert, inspect


def main(argv=None):
    parser = argparse.ArgumentParser(prog='pixel-prop')
    commands = parser.add_subparsers(dest='command', required=True)
    convert_parser = commands.add_parser('convert')
    convert_parser.add_argument('input', type=Path)
    convert_parser.add_argument('-o', '--output', type=Path, required=True)
    convert_parser.add_argument('--recipe', type=Path)
    convert_parser.add_argument('--report', type=Path)
    convert_parser.add_argument('--compare', type=Path)
    for name in ('size', 'padding', 'colors', 'alphaThreshold'):
        convert_parser.add_argument('--' + ('alpha-threshold' if name == 'alphaThreshold' else name), dest=name, type=int)
    for name in ('anchor', 'resample', 'palette', 'outline', 'background'):
        convert_parser.add_argument('--' + name)
    convert_parser.add_argument('--dither', action=argparse.BooleanOptionalAction, default=None)
    convert_parser.add_argument('--remove-isolated', dest='removeIsolated', action=argparse.BooleanOptionalAction, default=None)
    commands.add_parser('inspect').add_argument('input', type=Path)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        if exc.code: print(json.dumps({'error': 'Invalid command arguments'}))
        return exc.code
    try:
        if args.command == 'inspect':
            report = inspect(args.input.read_bytes())
        else:
            data = json.loads(args.recipe.read_text(encoding='utf-8')) if args.recipe else {}
            if not isinstance(data, dict): raise ValueError('recipe must be an object')
            for name in Recipe.__dataclass_fields__:
                if hasattr(args, name) and getattr(args, name) is not None:
                    data[name] = getattr(args, name)
            if args.recipe and args.palette is None and isinstance(data.get('palette'), str):
                data['palette'] = str(args.recipe.parent / data['palette'])
            recipe = Recipe.from_dict(data)
            result = convert(args.input.read_bytes(), recipe)
            args.output.write_bytes(result.png)
            if args.report: args.report.write_text(json.dumps(result.report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            if args.compare: args.compare.write_bytes(result.compare)
            report = result.report
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        return 0
    except (InputError, OSError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False)); return 3
    except (ValueError, TypeError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False)); return 2


if __name__ == '__main__':
    sys.exit(main())
