// A nyomtatható plakát „Nyomtatás" gombja (külön fájl: a CSP nem enged beágyazott szkriptet)
document.getElementById('print')?.addEventListener('click', () => window.print());
