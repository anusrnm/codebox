#!/usr/bin/env python3
import argparse
import signal
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Event, Lock


def parse_repository(
    value: str, organization: str, default_group: str, use_default_group: bool
) -> tuple[str, str, str]:
    repository = value.strip()
    if "/" in repository:
        organization, repository = repository.split("/", 1)
    elif default_group and use_default_group:
        repository = f"{default_group}.{repository}"

    destination = repository.split(".", 1)[-1]
    return organization, repository, destination


def clone_repository(
    organization: str,
    value: str,
    default_group: str,
    use_default_group: bool,
    aborted: Event,
    processes: set[subprocess.Popen[object]],
    processes_lock: Lock,
) -> None:
    organization, repository, destination = parse_repository(
        value, organization, default_group, use_default_group
    )
    if not repository:
        return

    if (Path(destination) / ".git").is_dir():
        print(f"[SKIP] {destination} already exists")
        return

    if aborted.is_set():
        return
    repository_path = f"{organization}/{repository}" if organization else repository
    remote_url = f"git@github.com:{repository_path}.git"
    process = subprocess.Popen(
        ["git", "clone", remote_url, destination],
        stdout=subprocess.DEVNULL,
    )
    with processes_lock:
        processes.add(process)
    return_code = process.wait()
    with processes_lock:
        processes.discard(process)
    if aborted.is_set():
        return
    if return_code == 0:
        print(f"[OK] {remote_url}")
        return

    print(f"[FAIL] {destination}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Clone repositories in parallel, optionally using group/repository entries."
    )
    parser.add_argument("repo_file", type=Path)
    parser.add_argument("--organization", default="", help="Optional GitHub organization.")
    parser.add_argument("--group", default="", help="Default group prefix for bare repository names.")
    parser.add_argument(
        "--parallel-jobs", type=int, default=4, help="Number of concurrent clones (default: 4)."
    )
    parser.add_argument(
        "--no-group-prefix",
        action="store_true",
        help="Do not prepend --group to bare repository names.",
    )
    arguments = parser.parse_args()

    if arguments.parallel_jobs < 1:
        parser.error("parallel-jobs must be a positive integer")
    if not arguments.repo_file.is_file():
        parser.error(f"Repository file not found: {arguments.repo_file}")

    repositories = arguments.repo_file.read_text(encoding="utf-8").splitlines()
    aborted = Event()
    processes: set[subprocess.Popen[object]] = set()
    processes_lock = Lock()
    executor = ThreadPoolExecutor(max_workers=arguments.parallel_jobs)
    futures = []
    try:
        for repository in repositories:
            if repository.strip():
                futures.append(
                    executor.submit(
                        clone_repository,
                        arguments.organization,
                        repository,
                        arguments.group,
                        not arguments.no_group_prefix,
                        aborted,
                        processes,
                        processes_lock,
                    )
                )
        for future in as_completed(futures):
            future.result()
    except KeyboardInterrupt:
        aborted.set()
        for future in futures:
            future.cancel()
        with processes_lock:
            for process in processes:
                process.send_signal(signal.SIGINT)
        print("\n[ABORTED] Clone operation cancelled", file=sys.stderr)
        raise SystemExit(130)
    finally:
        executor.shutdown(wait=not aborted.is_set(), cancel_futures=aborted.is_set())


if __name__ == "__main__":
    main()