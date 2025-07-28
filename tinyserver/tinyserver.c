// tinyserver.c
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <string.h>
#include <arpa/inet.h>
#endif

#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
volatile int keep_running = 1;
int sockfd = -1;

void handle_sigint(int sig) {
    (void)sig;
    keep_running = 0;
    printf("\nReceived SIGINT, shutting down server...\n");
    // Do not close sockets or print here; let main handle cleanup and message
}

const char *html_template =
"HTTP/1.1 200 OK\r\n"
"Content-Type: text/html\r\n"
"Content-Length: %ld\r\n"
"\r\n"
"%s";

int main(int argc, char *argv[]) {

    signal(SIGINT, handle_sigint);
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <html-file>\n", argv[0]);
        return 1;
    }

    // ...existing code...

#ifdef _WIN32
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
#endif

    sockfd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(8080);
    addr.sin_addr.s_addr = INADDR_ANY;

    bind(sockfd, (struct sockaddr*)&addr, sizeof(addr));
    listen(sockfd, 1);

    while (keep_running) {
        int client =
#ifdef _WIN32
            accept(sockfd, NULL, NULL);
#else
            accept(sockfd, NULL, NULL);
#endif
        if (client < 0) continue;



        // Read the HTTP request (just enough to get the headers)
        char reqbuf[1024];
        int recvd = recv(client, reqbuf, sizeof(reqbuf) - 1, 0);
        if (recvd <= 0) {
#ifdef _WIN32
            closesocket(client);
#else
            close(client);
#endif
            continue;
        }
        reqbuf[recvd] = '\0';

        // Check if the request is for /favicon.ico
        if (strncmp(reqbuf, "GET /favicon.ico", 16) == 0) {
            const char *notfound =
                "HTTP/1.1 404 Not Found\r\n"
                "Content-Type: text/plain\r\n"
                "Content-Length: 13\r\n"
                "\r\n"
                "404 Not Found";
            send(client, notfound, (int)strlen(notfound), 0);
#ifdef _WIN32
            closesocket(client);
#else
            close(client);
#endif
            continue;
        }

        // Parse the GET path
        char method[8], path[256];
        sscanf(reqbuf, "%7s %255s", method, path);

        // Determine the directory of the HTML file
        char *lastslash = strrchr(argv[1], '/');
        char *lastbslash = strrchr(argv[1], '\\');
        char *dirsep = lastslash > lastbslash ? lastslash : lastbslash;
        char dir[260] = "";
        if (dirsep) {
            size_t dlen = dirsep - argv[1] + 1;
            strncpy(dir, argv[1], dlen);
            dir[dlen] = '\0';
        }

        // Serve .js or .css files if requested
        if (strncmp(path, "/", 1) == 0 && (strstr(path, ".js") || strstr(path, ".css"))) {
            const char *ext = strrchr(path, '.');
            const char *ctype = NULL;
            if (ext && strcmp(ext, ".js") == 0) ctype = "application/javascript";
            else if (ext && strcmp(ext, ".css") == 0) ctype = "text/css";
            if (ctype) {
                char filepath[520];
                snprintf(filepath, sizeof(filepath), "%s%s", dir, path+1); // skip leading '/'
                FILE *f = fopen(filepath, "rb");
                if (!f) {
                    const char *notfound =
                        "HTTP/1.1 404 Not Found\r\n"
                        "Content-Type: text/plain\r\n"
                        "Content-Length: 13\r\n"
                        "\r\n"
                        "404 Not Found";
                    send(client, notfound, (int)strlen(notfound), 0);
#ifdef _WIN32
                    closesocket(client);
#else
                    close(client);
#endif
                    continue;
                }
                fseek(f, 0, SEEK_END);
                long filesize = ftell(f);
                fseek(f, 0, SEEK_SET);
                char *content = malloc(filesize);
                if (!content) {
                    fprintf(stderr, "Memory allocation failed\n");
                    fclose(f);
#ifdef _WIN32
                    closesocket(client);
#else
                    close(client);
#endif
                    continue;
                }
                fread(content, 1, filesize, f);
                fclose(f);
                char header[512];
                int hlen = snprintf(header, sizeof(header),
                    "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %ld\r\n\r\n",
                    ctype, filesize);
                send(client, header, hlen, 0);
                send(client, content, filesize, 0);
                free(content);
#ifdef _WIN32
                closesocket(client);
#else
                close(client);
#endif
                continue;
            }
        }

        // Otherwise, serve the HTML file
        FILE *f = fopen(argv[1], "rb");
        if (!f) {
            perror("Failed to open HTML file");
#ifdef _WIN32
            closesocket(client);
#else
            close(client);
#endif
            continue;
        }
        fseek(f, 0, SEEK_END);
        long filesize = ftell(f);
        fseek(f, 0, SEEK_SET);
        char *content = malloc(filesize + 1);
        if (!content) {
            fprintf(stderr, "Memory allocation failed\n");
            fclose(f);
#ifdef _WIN32
            closesocket(client);
#else
            close(client);
#endif
            continue;
        }
        fread(content, 1, filesize, f);
        content[filesize] = '\0';
        fclose(f);

        char *buffer = malloc(filesize + 512);
        if (!buffer) {
            fprintf(stderr, "Memory allocation failed\n");
            free(content);
#ifdef _WIN32
            closesocket(client);
#else
            close(client);
#endif
            continue;
        }
        int len = snprintf(buffer, filesize + 512, html_template, filesize, content);
        send(client, buffer, len, 0);
        free(buffer);
        free(content);

#ifdef _WIN32
        closesocket(client);
#else
        close(client);
#endif
    }


#ifdef _WIN32
    if (sockfd != -1) {
        closesocket(sockfd);
        sockfd = -1;
    }
    WSACleanup();
#else
    if (sockfd != -1) {
        close(sockfd);
        sockfd = -1;
    }
#endif
    printf("\nServer shutting down.\n");
    return 0;
}
