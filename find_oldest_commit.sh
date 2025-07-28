#!/bin/bash
# Check if an author name was provided
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 \"Author Name\""
  exit 1
fi

author="$1"

# Create a temporary file to store results.
tmpfile=$(mktemp)

# Loop through immediate subdirectories in the current directory.
for repo_dir in */; do
    # Check if the directory contains a .git folder (i.e. is a Git repository)
    if [ -d "${repo_dir}.git" ]; then
        echo "Checking repository: ${repo_dir}"
        (
            cd "$repo_dir" || exit

            # Use git log to get the oldest commit by the author.
            # %at gives the commit date as Unix epoch, which allows numeric sorting.
            commit_info=$(git log --author="$author" --reverse --pretty=format:"%at|%h - %ad - %an: %s" | head -n 1)
            
            # Only process if a commit was found.
            if [ -n "$commit_info" ]; then
                # Prepend the repository folder name for clarity.
                echo "${repo_dir}|${commit_info}" >> "$tmpfile"
            fi
        )
    fi
done

# Check if the temporary file has any entries.
if [ ! -s "$tmpfile" ]; then
    echo "No commits by author \"$author\" were found in any repository."
    rm "$tmpfile"
    exit 0
fi

# Sort the temporary file by the Unix epoch timestamp (the second field)
# using the pipe "|" as a delimiter, then pick the first (oldest) commit.
oldest_entry=$(sort -t"|" -k2,2n "$tmpfile" | head -n 1)

# Format the output.
IFS='|' read -r repo_dir rest <<< "$oldest_entry"
IFS='|' read -r epoch commit_details <<< "$rest"

echo "Overall oldest commit by \"$author\" is in repository: ${repo_dir}"
echo "Commit details: $commit_details"

# Clean up
rm "$tmpfile"
