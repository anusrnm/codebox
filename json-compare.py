#!/usr/bin/env python3
"""
JSON Comparison and Sorting Utility

Handles two main operations:
1. Sort JSON files alphabetically by keys (recursive)
2. Compare two JSON files and report differences

Usage:
    python json-compare.py sort <file> [--output <out>] [--inplace] [--format json|text]
    python json-compare.py compare <file1> <file2> [--output <out>] [--format json|text|diff]
"""

import json
import sys
import argparse
from pathlib import Path
from typing import Any, Dict, List, Tuple


def load_json(filepath: str) -> Any:
    """Load and parse a JSON file.
    
    Args:
        filepath: Path to the JSON file
        
    Returns:
        Parsed JSON data
        
    Raises:
        FileNotFoundError: If file doesn't exist
        json.JSONDecodeError: If JSON is invalid
    """
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"Error: File not found: {filepath}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in {filepath}: {e}", file=sys.stderr)
        sys.exit(1)


def sort_json_keys(obj: Any) -> Any:
    """Recursively sort all keys in a JSON object and array values alphabetically.
    
    Args:
        obj: JSON object (dict, list, or primitive)
        
    Returns:
        JSON object with all keys and array values sorted recursively
    """
    if isinstance(obj, dict):
        return {k: sort_json_keys(obj[k]) for k in sorted(obj.keys())}
    elif isinstance(obj, list):
        # Recursively process items first
        processed = [sort_json_keys(item) for item in obj]
        
        # Try to sort the list if all items are primitives (sortable)
        if processed and all(isinstance(item, (str, int, float, bool, type(None))) for item in processed):
            return sorted(processed)
        else:
            # Keep order for lists of objects/nested arrays
            return processed
    else:
        return obj


def compare_jsons(obj1: Any, obj2: Any, path: str = "") -> Dict[str, Any]:
    """Deep compare two JSON objects.
    
    Args:
        obj1: First JSON object
        obj2: Second JSON object
        path: Current path in the JSON structure (for reporting)
        
    Returns:
        Dictionary with keys: added, removed, modified
    """
    result = {
        "added": {},
        "removed": {},
        "modified": {}
    }
    
    # Handle type mismatches
    if type(obj1) != type(obj2):
        result["modified"][path or "root"] = {
            "old_type": type(obj1).__name__,
            "new_type": type(obj2).__name__,
            "old_value": obj1,
            "new_value": obj2
        }
        return result
    
    # Compare dictionaries
    if isinstance(obj1, dict):
        all_keys = set(obj1.keys()) | set(obj2.keys())
        
        for key in all_keys:
            new_path = f"{path}.{key}" if path else key
            
            if key not in obj1:
                result["added"][new_path] = obj2[key]
            elif key not in obj2:
                result["removed"][new_path] = obj1[key]
            else:
                # Recursively compare nested objects
                nested_diff = compare_jsons(obj1[key], obj2[key], new_path)
                result["added"].update(nested_diff["added"])
                result["removed"].update(nested_diff["removed"])
                result["modified"].update(nested_diff["modified"])
    
    # Compare lists
    elif isinstance(obj1, list):
        if len(obj1) != len(obj2):
            result["modified"][path or "root"] = {
                "old_length": len(obj1),
                "new_length": len(obj2),
                "old_value": obj1,
                "new_value": obj2
            }
        else:
            for i, (item1, item2) in enumerate(zip(obj1, obj2)):
                new_path = f"{path}[{i}]"
                nested_diff = compare_jsons(item1, item2, new_path)
                result["added"].update(nested_diff["added"])
                result["removed"].update(nested_diff["removed"])
                result["modified"].update(nested_diff["modified"])
    
    # Compare primitives
    elif obj1 != obj2:
        result["modified"][path or "root"] = {
            "old_value": obj1,
            "new_value": obj2
        }
    
    return result


def format_comparison_text(diff: Dict[str, Any]) -> str:
    """Format comparison results as human-readable text.
    
    Args:
        diff: Comparison result from compare_jsons()
        
    Returns:
        Formatted text report
    """
    lines = []
    
    if diff["removed"]:
        lines.append("REMOVED:")
        for key, value in sorted(diff["removed"].items()):
            lines.append(f"  - {key}: {json.dumps(value, indent=4)[:60]}...")
    
    if diff["added"]:
        if lines:
            lines.append("")
        lines.append("ADDED:")
        for key, value in sorted(diff["added"].items()):
            lines.append(f"  + {key}: {json.dumps(value, indent=4)[:60]}...")
    
    if diff["modified"]:
        if lines:
            lines.append("")
        lines.append("MODIFIED:")
        for key, change in sorted(diff["modified"].items()):
            old = change.get("old_value")
            new = change.get("new_value")
            lines.append(f"  ~ {key}:")
            lines.append(f"      old: {json.dumps(old, indent=4)[:60]}")
            lines.append(f"      new: {json.dumps(new, indent=4)[:60]}")
    
    if not lines:
        lines.append("No differences found.")
    
    return "\n".join(lines)


def format_comparison_diff(obj1: Any, obj2: Any) -> str:
    """Format comparison results as a unified diff-like format.
    
    Args:
        obj1: First JSON object
        obj2: Second JSON object
        
    Returns:
        Diff-style format
    """
    json1_str = json.dumps(obj1, indent=2, sort_keys=True).split('\n')
    json2_str = json.dumps(obj2, indent=2, sort_keys=True).split('\n')
    
    lines = ["--- file1", "+++ file2"]
    
    i, j = 0, 0
    while i < len(json1_str) or j < len(json2_str):
        if i < len(json1_str) and j < len(json2_str) and json1_str[i] == json2_str[j]:
            lines.append(f" {json1_str[i]}")
            i += 1
            j += 1
        elif i < len(json1_str):
            lines.append(f"-{json1_str[i]}")
            i += 1
        else:
            lines.append(f"+{json2_str[j]}")
            j += 1
    
    return "\n".join(lines)


def save_output(content: str, output_path: str) -> None:
    """Save output to a file.
    
    Args:
        content: Content to save
        output_path: Path to output file
    """
    try:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Output saved to: {output_path}")
    except IOError as e:
        print(f"Error writing to {output_path}: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_sort(args: argparse.Namespace) -> None:
    """Handle 'sort' command."""
    data = load_json(args.file)
    sorted_data = sort_json_keys(data)
    
    # Format output
    if args.format == 'text':
        output = json.dumps(sorted_data, indent=2)
    else:  # json format (default)
        output = json.dumps(sorted_data, indent=2)
    
    # Handle output destination
    if args.inplace:
        save_output(output, args.file)
    elif args.output:
        save_output(output, args.output)
    else:
        print(output)


def cmd_compare(args: argparse.Namespace) -> None:
    """Handle 'compare' command."""
    obj1 = load_json(args.file1)
    obj2 = load_json(args.file2)
    
    # Generate comparison
    diff = compare_jsons(obj1, obj2)
    
    # Format output
    if args.format == 'json':
        output = json.dumps(diff, indent=2)
    elif args.format == 'diff':
        output = format_comparison_diff(obj1, obj2)
    else:  # text format (default)
        output = format_comparison_text(diff)
    
    # Handle output destination
    if args.output:
        save_output(output, args.output)
    else:
        print(output)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Compare and sort JSON files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Sort JSON file and display
  python json-compare.py sort data.json
  
  # Sort JSON file in-place
  python json-compare.py sort data.json --inplace
  
  # Compare two JSON files
  python json-compare.py compare file1.json file2.json
  
  # Compare with diff output format
  python json-compare.py compare file1.json file2.json --format diff
  
  # Save comparison report
  python json-compare.py compare file1.json file2.json --output report.txt
        """
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Command to execute')
    
    # Sort command
    sort_parser = subparsers.add_parser('sort', help='Sort JSON file by keys')
    sort_parser.add_argument('file', help='JSON file to sort')
    sort_parser.add_argument('--output', '-o', help='Output file (default: stdout)')
    sort_parser.add_argument('--inplace', '-i', action='store_true', 
                            help='Modify file in-place')
    sort_parser.add_argument('--format', '-f', choices=['json', 'text'], 
                            default='json', help='Output format (default: json)')
    sort_parser.set_defaults(func=cmd_sort)
    
    # Compare command
    compare_parser = subparsers.add_parser('compare', help='Compare two JSON files')
    compare_parser.add_argument('file1', help='First JSON file')
    compare_parser.add_argument('file2', help='Second JSON file')
    compare_parser.add_argument('--output', '-o', help='Output file (default: stdout)')
    compare_parser.add_argument('--format', '-f', choices=['json', 'text', 'diff'], 
                               default='text', help='Output format (default: text)')
    compare_parser.set_defaults(func=cmd_compare)
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    args.func(args)


if __name__ == '__main__':
    main()
