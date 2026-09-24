from pathlib import Path
import re

root = Path(r'c:\Users\st\Desktop\xmetal-main')
include_dirs = [root / 'js', root / 'mobile-sales', root / 'tests']
root_files = [root / 'index.html', root / 'mobile-sales.html']

replacements = [
    ('secondary', ''),
    ('secondaryCurrency', ''),
    ('defaultInputCurrency', 'defaultInputMode'),
    ('defaultSellCurrency', 'defaultSaleMode'),
    ('showDualMobileProductPrices', 'showProductPrices'),
    ('exchangeRateAtTime', 'rateAtTime'),
    ('exchangeRate', 'rate'),
    ('systemCurrency', 'baseCurrency'),
    ('dailyWageSecondary', 'dailyWagePrimary'),
    ('saleCurrency', 'saleMode'),
    ('purchaseCurrency', 'purchaseMode'),
    ('mechanicCurrency', 'mechanicMode'),
    ('sellCurrency', 'sellMode'),
    ('tempSellCurrency', 'tempSellMode'),
    ('tempPurchaseCurrency', 'tempPurchaseMode'),
    ('tempMechanicCurrency', 'tempMechanicMode'),
    ('tempEditCurrency', 'tempEditMode'),
    ('displaySecondaryCurrency', 'displayPrimaryCurrency'),
    ('currencySettings.secondaryCurrencySymbol', 'currencySettings.currencySymbol'),
    ('currencySettings.secondaryCurrencyName', 'currencySettings.currencyName'),
]

files = []
for d in include_dirs:
    if d.exists():
        files.extend([p for p in d.rglob('*') if p.is_file() and p.suffix.lower() in {'.js', '.html'}])
for p in root_files:
    if p.exists():
        files.append(p)

count = 0
for p in sorted(set(files)):
    try:
        text = p.read_text(encoding='utf-8')
    except Exception:
        continue
    original = text
    for old, new in replacements:
        text = text.replace(old, new)
    text = re.sub(r'(?i)\bsecondary\b', '', text)
    text = text.replace('  ', ' ')
    if text != original:
        p.write_text(text, encoding='utf-8')
        count += 1

print(f'updated {count} files')
