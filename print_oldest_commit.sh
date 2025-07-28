#!/bin/bash

# Check if an author name was provided
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 \"Author Name\""
  exit 1
fi

author="$1"

# Loop through all folders in the current directory
for repo_dir in */; do
    # Check if the directory contains a .git folder
    if [ -d "${repo_dir}.git" ]; then
        echo "Repository: ${repo_dir}"
        (
            cd "$repo_dir" || exit
            # Get the oldest commit by this author in the repository
            git log --author="$author" --reverse --pretty=format:"%h - %ad - %an: %s" | head -n 1
        )
        echo    # Print an empty line for separation
    fi
done

