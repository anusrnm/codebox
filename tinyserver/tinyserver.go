package main

import (
    "flag"
    "io/ioutil"
    "net/http"
    "os"
)

var htmlFile string

func handler(w http.ResponseWriter, r *http.Request) {
    data, err := ioutil.ReadFile(htmlFile)
    if err != nil {
        http.Error(w, "File not found", http.StatusNotFound)
        return
    }
    w.Header().Set("Content-Type", "text/html")
    w.Write(data)
}

func main() {
    flag.StringVar(&htmlFile, "file", "index.html", "HTML file to serve")
    flag.Parse()
    if _, err := os.Stat(htmlFile); err != nil {
        panic("HTML file does not exist: " + htmlFile)
    }
    http.HandleFunc("/", handler)
    http.ListenAndServe(":8080", nil)
}
