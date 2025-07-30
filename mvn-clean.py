import os
import subprocess
import sys
import shutil
from multiprocessing import Pool, Manager
from typing import List, Tuple

ERROR = "\u274C"  # unicode character for error messages
INFO = "\u2139"  # unicode character for informational messages

def get_dir_size(path: str) -> int:
    """
    Returns the total size in bytes of the directory at 'path', skipping symlinks and unreadable files.
    Faster and more robust using os.scandir.
    """
    total = 0
    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
                    elif entry.is_dir(follow_symlinks=False):
                        total += get_dir_size(entry.path)
                except Exception:
                    continue
    except Exception:
        pass
    return total

def clean_maven_in_target_dir(item_path: str, mvn_path: str) -> Tuple[str, str]:
    """
    Runs 'mvn clean' in the specified directory.
    Returns a tuple: (item_path, error_message). error_message is empty if successful.
    """
    try:
        subprocess.run([mvn_path, "-q", "clean"], cwd=item_path, check=True)
        print(f"Maven clean executed successfully in '{item_path}'.")
        return (item_path, "")
    except subprocess.CalledProcessError as e:
        return (item_path, f"Error executing mvn clean: {e}")
    except OSError as e:
        return (item_path, f"OS error: {e}")
def find_target_dirs(base_path: str) -> List[str]:
    """
    Finds Maven project directories (with 'pom.xml' and 'target' folder) in the base directory.
    """
    target_dirs = []
    for item in os.listdir(base_path):
        item_path = os.path.join(base_path, item)
        target_folder = os.path.join(item_path, "target")
        pom = os.path.join(item_path, "pom.xml")
        if os.path.exists(target_folder) and os.path.isdir(target_folder) and os.path.exists(pom):
            target_dirs.append(item_path)
    return target_dirs

def format_size(bytes_size: int) -> str:
    """
    Formats bytes as human-readable string.
    """
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes_size < 1024:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024
    return f"{bytes_size:.2f} PB"

def parse_args():
    import argparse
    parser = argparse.ArgumentParser(description="Clean Maven target directories in subfolders.")
    parser.add_argument("base_path", nargs="?", default=os.getcwd(), help="Base directory to search for Maven projects.")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be cleaned and reclaimed, but do not run mvn clean.")
    return parser.parse_args()

def resolve_mvn_path(dry_run: bool) -> str:
    mvn_path = shutil.which("mvn.cmd") if os.name == "nt" else shutil.which("mvn")
    if mvn_path is None:
        mvn_path = shutil.which("mvn")
    if mvn_path is None and not dry_run:
        print(f"{ERROR} Maven (mvn) command not found in PATH. Please ensure Maven is installed and available.")
        sys.exit(1)
    return mvn_path

def main():
    """
    Main entry point for cleaning Maven target directories in subfolders.
    Supports optional --dry-run argument to only show what would be cleaned.
    """
    args = parse_args()
    base_path = args.base_path
    dry_run = args.dry_run


    if not os.path.exists(base_path):
        print(f"{ERROR} Base path '{base_path}' does not exist.")
        sys.exit(1)
    if not os.path.isdir(base_path):
        print(f"{ERROR} Base path '{base_path}' is not a directory.")
        sys.exit(1)

    mvn_path = resolve_mvn_path(dry_run)

    target_dirs = find_target_dirs(base_path)
    if not target_dirs:
        print(f"{ERROR} No Maven target directories found.")
        return

    print(f"{INFO} Found {len(target_dirs)} Maven project(s) to clean.")

    # Calculate total size of all target directories before cleaning
    total_bytes = 0
    target_sizes = {}
    for dir_path in target_dirs:
        target_folder = os.path.join(dir_path, "target")
        if os.path.exists(target_folder):
            size = get_dir_size(target_folder)
            target_sizes[dir_path] = size
            total_bytes += size

    print(f"{INFO} Total disk space that will be reclaimed: {format_size(total_bytes)}")

    print(f"\n{INFO} Directories to be cleaned:")
    for dir_path in target_dirs:
        size = target_sizes.get(dir_path, 0)
        print(f" - {dir_path} ({format_size(size)})")

    if dry_run:
        print(f"\n{INFO} Dry run: No directories were cleaned.")
        return

    # Multiprocessing-safe result collection
    with Pool(processes=os.cpu_count()) as pool:
        results = pool.starmap(clean_maven_in_target_dir, [(dir_path, mvn_path) for dir_path in target_dirs])

    cleaned = [path for path, err in results if not err]
    errors = [(path, err) for path, err in results if err]

    print(f"\n{INFO} Cleaned directories:")
    for c in cleaned:
        print(f" - {c}")
    print(f" {INFO} Total cleaned directories: {len(cleaned)}")

    if errors:
        print(f"\n{ERROR} Errors encountered:")
        for path, err in errors:
            print(f" - {path}: {err}")
        print(f" {ERROR} Total errors: {len(errors)}")

    # Only sum sizes for successfully cleaned directories
    reclaimed_bytes = sum(target_sizes.get(path, 0) for path in cleaned)
    print(f"\n{INFO} Total disk space reclaimed: {format_size(reclaimed_bytes)}")

if __name__ == "__main__":
    main()
