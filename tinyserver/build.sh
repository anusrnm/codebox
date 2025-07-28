# docker run --rm -v $(pwd):/src tinygo/tinygo:latest tinygo build -o tinyserver.exe -target windows ./tinyserver.go
x86_64-w64-mingw32-gcc -Os -s tinyserver.c -o tinyserver.exe -lws2_32