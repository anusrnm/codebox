console.time("Took")
let a=0
for(let i=0; i<=100000; i++) {
    a = a + 1 * 100 / .5 - 1
    //console.log(a)
}
console.log(a)
console.timeEnd("Took")