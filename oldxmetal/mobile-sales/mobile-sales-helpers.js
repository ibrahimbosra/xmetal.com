(function (global) {
    'use strict';

    var ARABIC_LETTER_MAP = {
        a: 'ا', b: 'ب', c: 'س', d: 'د', e: 'ع', f: 'ف', g: 'ج', h: 'ح', i: 'ي', j: 'ج',
        k: 'ك', l: 'ل', m: 'م', n: 'ن', o: 'و', p: 'ب', q: 'ق', r: 'ر', s: 'س', t: 'ت',
        u: 'و', v: 'ف', w: 'و', x: 'س', y: 'ي', z: 'ز'
    };

    function normalizeEmailKey(value) {
        return String(value == null ? '' : value).trim().toLowerCase().replace(/[\u200E\u200F]/g, '');
    }

    function flattenNameMap(source) {
        var target = {};
        if (!source || typeof source !== 'object') return target;

        if (Array.isArray(source)) {
            source.forEach(function (entry) {
                if (!entry || typeof entry !== 'object') return;
                var email = entry.email || entry.userEmail || entry.username || entry.mail || entry.account;
                var name = entry.name || entry.displayName || entry.fullName || entry.label;
                if (email && name) target[normalizeEmailKey(email)] = String(name).trim();
            });
            return target;
        }

        Object.keys(source).forEach(function (key) {
            var value = source[key];
            if (value && typeof value === 'object') {
                if (value.email || value.userEmail) {
                    var nestedEmail = value.email || value.userEmail;
                    var nestedName = value.name || value.displayName || value.fullName || value.label || value.userName;
                    if (nestedEmail && nestedName) target[normalizeEmailKey(nestedEmail)] = String(nestedName).trim();
                    return;
                }
                Object.keys(value).forEach(function (nestedKey) {
                    var nestedValue = value[nestedKey];
                    if (nestedValue && typeof nestedValue === 'string') target[normalizeEmailKey(nestedKey)] = String(nestedValue).trim();
                });
                return;
            }
            if (typeof value === 'string' && key) {
                if (/@/.test(String(key))) target[normalizeEmailKey(key)] = String(value).trim();
                else if (typeof source.emails === 'object' && source.emails[key]) target[normalizeEmailKey(key)] = String(source.emails[key]).trim();
            }
        });

        return target;
    }

    function resolveSellerName(email, fallbackName, rawNameMap) {
        var cleanedEmail = normalizeEmailKey(email);
        var cleanedFallback = String(fallbackName == null ? '' : fallbackName).trim();
        if (!cleanedEmail) return cleanedFallback || '';

        var map = flattenNameMap(rawNameMap || {});
        if (map[cleanedEmail] && String(map[cleanedEmail]).trim()) return String(map[cleanedEmail]).trim();
        if (rawNameMap && rawNameMap[cleanedEmail] && String(rawNameMap[cleanedEmail]).trim()) return String(rawNameMap[cleanedEmail]).trim();
        if (rawNameMap && rawNameMap[String(email).trim()] && String(rawNameMap[String(email).trim()]).trim()) return String(rawNameMap[String(email).trim()]).trim();
        return cleanedFallback || email || '';
    }

    function normalizeArabicInitial(value) {
        return String(value == null ? '' : value)
            .replace(/[أإآ]/g, 'ا')
            .replace(/ة/g, 'ت');
    }

    function getArabicInitial(value) {
        var raw = String(value == null ? '' : value).trim();
        if (!raw) return 'ا';

        var arabicMatches = raw.match(/[ابتثجحخدذرزسشصضطظعغفقكلمنهوياءأإآؤةى]/g);
        if (arabicMatches && arabicMatches.length) return normalizeArabicInitial(arabicMatches[0]);

        var englishMatch = raw.match(/[A-Za-z]/);
        if (englishMatch) {
            var letter = englishMatch[0].toLowerCase();
            return ARABIC_LETTER_MAP[letter] || 'ا';
        }

        return 'ا';
    }

    function normalizeIdValue(value) {
        return String(value == null ? '' : value).trim();
    }

    function getRecordKey(record, allowedKeys) {
        if (!record || typeof record !== 'object') return '';
        var candidates = Array.isArray(allowedKeys) ? allowedKeys : [];
        for (var i = 0; i < candidates.length; i += 1) {
            var candidateKey = normalizeIdValue(record[candidates[i]]);
            if (candidateKey) return candidateKey;
        }
        var fallbackKeys = [
            record.saleId,
            record.id,
            record.debtOperationId,
            record.operationId,
            record.linkedDebtOperationId,
            record.relatedDebtOperationId,
            record.saleDebtOperationId
        ];
        for (var j = 0; j < fallbackKeys.length; j += 1) {
            var fallbackKey = normalizeIdValue(fallbackKeys[j]);
            if (fallbackKey) return fallbackKey;
        }
        return '';
    }

    function uniqueRecordsById(list, allowedKeys) {
        var source = Array.isArray(list) ? list : [];
        var seen = new Map();
        var unique = [];
        source.forEach(function (record) {
            var recordKey = getRecordKey(record, allowedKeys);
            if (!recordKey) {
                unique.push(record);
                return;
            }
            if (!seen.has(recordKey)) {
                seen.set(recordKey, unique.length);
                unique.push(record);
                return;
            }
            var existingIndex = seen.get(recordKey);
            unique[existingIndex] = Object.assign({}, unique[existingIndex], record);
        });
        return unique;
    }

    function getDebtCycleDateValue(entry) {
        if (!entry || typeof entry !== 'object') return 0;
        var directDate = entry.operationDate || entry.operation_date || entry.dateKey || entry.date || entry.operationDateKey || '';
        if (typeof directDate === 'string' && directDate.trim()) {
            var trimmed = directDate.trim();
            var isoCandidate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed + 'T12:00:00' : trimmed;
            var parsed = Date.parse(isoCandidate);
            if (Number.isFinite(parsed)) return parsed;
        }
        if (entry.timestamp && typeof entry.timestamp.toMillis === 'function') return entry.timestamp.toMillis();
        if (entry.timestamp && Number.isFinite(Number(entry.timestamp.seconds))) return Number(entry.timestamp.seconds) * 1000 + (Number(entry.timestamp.nanoseconds) || 0) / 1000000;
        if (entry.timestamp instanceof Date) return entry.timestamp.getTime();
        var numeric = Number(entry.timestamp);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
        return 0;
    }

    function groupDebtOperationsByCycles(operations) {
        var source = Array.isArray(operations) ? operations.filter(function (entry) {
            if (!entry || typeof entry !== 'object') return false;
            var type = String(entry.type || '').trim().toLowerCase();
            if (type !== 'debt' && type !== 'payment' && type !== 'settle') return false;
            return String(entry.status || '').trim().toLowerCase() !== 'cancelled';
        }) : [];

        var ordered = source.slice().sort(function (a, b) {
            return getDebtCycleDateValue(a) - getDebtCycleDateValue(b);
        });

        var cycles = [];
        var currentCycle = null;
        var runningBalance = 0;

        ordered.forEach(function (entry) {
            var type = String(entry.type || '').trim().toLowerCase();
            var amount = Number(entry.amount) || 0;
            if (!currentCycle && type !== 'debt') return;
            if (!currentCycle) {
                currentCycle = { entries: [] };
                cycles.push(currentCycle);
            }

            currentCycle.entries.push(entry);
            if (type === 'debt') runningBalance += amount;
            else runningBalance -= amount;

            if (runningBalance <= 0) {
                currentCycle.balance = runningBalance;
                currentCycle = null;
                runningBalance = 0;
            }
        });

        return cycles.reverse().map(function (cycle) {
            var balance = 0;
            (cycle.entries || []).forEach(function (entry) {
                var type = String(entry.type || '').trim().toLowerCase();
                var amount = Number(entry.amount) || 0;
                if (type === 'debt') balance += amount;
                else if (type === 'payment' || type === 'settle') balance -= amount;
            });
            return {
                entries: (cycle.entries || []).slice().sort(function (a, b) {
                    return getDebtCycleDateValue(b) - getDebtCycleDateValue(a);
                }),
                balance: balance
            };
        });
    }

    function normalizeSaleForCancellation(sale) {
        var record = sale && typeof sale === 'object' ? Object.assign({}, sale) : {};
        var quantity = Number(record.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            var totalAmount = Number(record.displayTotalAmount || record.rawTotalAmount || record.totalAmount || record.amount || 0) || 0;
            var unitPrice = Number(record.unitPrice || record.saleUnitPrice || record.pricePerUnit || 0) || 0;
            if (unitPrice > 0 && totalAmount > 0) {
                quantity = totalAmount / unitPrice;
            }
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
            quantity = 0;
        }
        record.saleId = normalizeIdValue(record.saleId || record.id || record.relatedSaleId || record.linkedSaleId || record.saleDebtOperationId || record.debtOperationId || record.relatedDebtOperationId || record.linkedDebtOperationId);
        record.itemId = normalizeIdValue(record.itemId || record.productId || record.itemID || '');
        record.quantity = quantity;
        return record;
    }

    function getSaleEditQuantityLimit(item, sale) {
        var currentStock = Number(item && item.quantity) || 0;
        var originalQuantity = Number(sale && sale.quantity) || 0;
        return Math.max(0, currentStock + originalQuantity);
    }

    function convertSecondaryToPrimary(value, exchangeRate) {
        var numericValue = Number(value) || 0;
        var rate = Number(exchangeRate) || 1;
        if (!Number.isFinite(numericValue)) return 0;
        if (!Number.isFinite(rate) || rate <= 0) return numericValue;
        return numericValue / rate;
    }

    function convertPrimaryToSecondary(value, exchangeRate) {
        var numericValue = Number(value) || 0;
        var rate = Number(exchangeRate) || 1;
        if (!Number.isFinite(numericValue)) return 0;
        if (!Number.isFinite(rate) || rate <= 0) return numericValue;
        return numericValue * rate;
    }

    function findLinkedDebtOperation(sale, debtOperations) {
        var saleRecord = sale || {};
        var list = Array.isArray(debtOperations) ? debtOperations : [];
        var candidateIds = [];
        candidateIds.push(saleRecord.debtOperationId, saleRecord.linkedDebtOperationId, saleRecord.relatedDebtOperationId, saleRecord.saleDebtOperationId, saleRecord.debtEntryId);

        for (var i = 0; i < candidateIds.length; i += 1) {
            var candidateId = normalizeIdValue(candidateIds[i]);
            if (!candidateId) continue;
            var direct = list.find(function (entry) {
                return entry && (String(entry.id) === candidateId || String(entry.operationId) === candidateId || String(entry.debtOperationId) === candidateId);
            });
            if (direct) return direct;
        }

        var saleId = normalizeIdValue(saleRecord.saleId);
        if (saleId) {
            var saleLinked = list.find(function (entry) {
                return entry && (String(entry.saleId) === saleId || String(entry.relatedSaleId) === saleId || String(entry.linkedSaleId) === saleId);
            });
            if (saleLinked) return saleLinked;
        }

        var customerId = normalizeIdValue(saleRecord.customerId);
        var totalAmount = Number(saleRecord.totalAmount || saleRecord.amount || 0) || 0;
        if (customerId && totalAmount > 0) {
            var amountMatch = list.find(function (entry) {
                if (!entry || String(entry.customerId) !== customerId) return false;
                return (Number(entry.amount) || 0) === totalAmount && (entry.type === 'debt' || entry.type === 'payment' || entry.type === 'settle');
            });
            if (amountMatch) return amountMatch;
        }

        return null;
    }

    function findSaleByDebtOperation(operation, salesList) {
        var debtOperation = operation || {};
        var saleCandidates = Array.isArray(salesList) ? salesList : [];
        var candidateIds = [
            normalizeIdValue(debtOperation.saleId),
            normalizeIdValue(debtOperation.relatedSaleId),
            normalizeIdValue(debtOperation.linkedSaleId),
            normalizeIdValue(debtOperation.debtOperationId),
            normalizeIdValue(debtOperation.relatedDebtOperationId),
            normalizeIdValue(debtOperation.linkedDebtOperationId),
            normalizeIdValue(debtOperation.saleDebtOperationId)
        ].filter(function (value) { return Boolean(value); });

        for (var i = 0; i < candidateIds.length; i += 1) {
            var candidateSaleId = candidateIds[i];
            var match = saleCandidates.find(function (sale) {
                if (!sale) return false;
                var saleId = normalizeIdValue(sale.saleId || sale.id || sale.relatedSaleId || sale.linkedSaleId || sale.debtOperationId || sale.relatedDebtOperationId || sale.linkedDebtOperationId || sale.saleDebtOperationId);
                if (!saleId) return false;
                if (String(saleId) === String(candidateSaleId)) return true;
                var debtOperationId = normalizeIdValue(sale.debtOperationId || sale.linkedDebtOperationId || sale.relatedDebtOperationId || sale.saleDebtOperationId);
                return Boolean(debtOperationId) && String(debtOperationId) === String(debtOperation.id || debtOperation.debtOperationId || debtOperation.operationId || '');
            });
            if (match) return match;
        }

        var operationId = normalizeIdValue(debtOperation.id || debtOperation.debtOperationId || debtOperation.operationId);
        if (operationId) {
            var idMatch = saleCandidates.find(function (sale) {
                if (!sale) return false;
                var saleDebtOperationId = normalizeIdValue(sale.debtOperationId || sale.linkedDebtOperationId || sale.relatedDebtOperationId || sale.saleDebtOperationId);
                return Boolean(saleDebtOperationId) && String(saleDebtOperationId) === String(operationId);
            });
            if (idMatch) return idMatch;
        }

        return null;
    }

    function normalizeTimestampValue(value) {
        if (value && typeof value.toMillis === 'function') return value.toMillis();
        if (value && Number.isFinite(Number(value.seconds))) return Number(value.seconds) * 1000 + (Number(value.nanoseconds) || 0) / 1000000;
        if (value instanceof Date) return value.getTime();
        var numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
        var parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function clampPercent(value) {
        var numeric = Number(value) || 0;
        if (!Number.isFinite(numeric)) return 0;
        return Math.min(100, Math.max(0, numeric));
    }

    function getPaymentProgressColor(percent) {
        var value = clampPercent(percent) / 100;
        var red = Math.round(216 + (21 - 216) * value);
        var green = Math.round(58 + (148 - 58) * value);
        var blue = Math.round(75 + (71 - 75) * value);
        return 'rgb(' + red + ', ' + green + ', ' + blue + ')';
    }

    function getSaleStatusKey(sale) {
        if (!sale || typeof sale !== 'object') return '';
        return String(sale.status || sale.saleStatus || sale.returnStatus || sale.refundStatus || '').trim().toLowerCase();
    }

    function isRefundedSale(sale) {
        var status = getSaleStatusKey(sale);
        return status === 'refunded' || status === 'returned' || status === 'cancelled' || status === 'cancelled_sale' || Boolean(sale && (sale.refunded === true || sale.isRefunded === true || sale.cancelled === true || sale.isCancelled === true));
    }

    function isOriginalCreditSale(sale) {
        if (!sale || typeof sale !== 'object') return false;
        var rawType = String(sale.paymentMethod || sale.saleType || sale.type || sale.saleKind || sale.creditType || '').trim().toLowerCase();
        return Boolean(
            sale.paymentMethod === 'credit' ||
            sale.isCreditSale === true ||
            sale.isCredit === true ||
            sale.saleType === 'credit' ||
            sale.type === 'credit' ||
            rawType === 'credit' ||
            rawType === 'آجل' ||
            rawType === 'installment' ||
            rawType === 'اجل'
        );
    }

    function getSaleReferenceAmount(sale) {
        var saleRecord = sale || {};
        var candidates = [
            saleRecord.displayTotalAmount,
            saleRecord.rawTotalAmount,
            saleRecord.displayAmount,
            saleRecord.rawAmount,
            saleRecord.totalAmount,
            saleRecord.amount
        ];
        for (var i = 0; i < candidates.length; i += 1) {
            var numeric = Number(candidates[i]);
            if (Number.isFinite(numeric)) return numeric;
        }
        return Number(saleRecord.totalAmount || saleRecord.amount || 0) || 0;
    }

    function getSaleNetAmount(sale) {
        var saleRecord = sale || {};
        var amount = getSaleReferenceAmount(saleRecord);
        var refundAmount = Number(saleRecord.refundAmount || saleRecord.refundedAmount || saleRecord.returnedAmount || 0) || 0;
        var partialStatus = getSaleStatusKey(saleRecord) === 'partially_refunded' || getSaleStatusKey(saleRecord) === 'partially_returned';
        if (partialStatus && refundAmount > 0) return Math.max(0, amount - refundAmount);
        return amount;
    }

    function getSalePaidAmount(sale, debtOperations) {
        var saleRecord = sale || {};
        var saleId = normalizeIdValue(saleRecord.saleId || saleRecord.id || saleRecord.debtOperationId || saleRecord.relatedSaleId || saleRecord.linkedSaleId || saleRecord.relatedDebtOperationId || saleRecord.linkedDebtOperationId || saleRecord.saleDebtOperationId);
        if (!saleId) return 0;
        var paidAmount = 0;
        var list = Array.isArray(debtOperations) ? debtOperations : [];
        list.forEach(function (entry) {
            if (!entry) return;
            var entryType = String(entry.type || '').trim().toLowerCase();
            if (entryType !== 'payment' && entryType !== 'settle') return;
            var allocations = Array.isArray(entry.allocations) ? entry.allocations : [];
            if (allocations.length) {
                allocations.forEach(function (allocation) {
                    if (!allocation) return;
                    var candidateSaleId = normalizeIdValue(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '');
                    if (String(candidateSaleId) === String(saleId)) {
                        paidAmount += Number(allocation.amount) || 0;
                    }
                });
                return;
            }
            var directSaleId = normalizeIdValue(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || '');
            if (String(directSaleId) === String(saleId)) {
                paidAmount += Number(entry.amount) || 0;
            }
        });
        return paidAmount;
    }

    function reconcileCreditSaleDebtAfterEdit(sale, debtOperations) {
        var saleRecord = sale || {};
        if (!saleRecord || !isOriginalCreditSale(saleRecord)) {
            return { debtAmount: 0, remainingDebt: 0, salePercent: 0, status: 'not-credit', operations: Array.isArray(debtOperations) ? debtOperations.slice() : [] };
        }
        var saleId = normalizeIdValue(saleRecord.saleId || saleRecord.id || saleRecord.debtOperationId || saleRecord.relatedSaleId || saleRecord.relatedDebtOperationId || saleRecord.linkedSaleId || saleRecord.linkedDebtOperationId || saleRecord.saleDebtOperationId);
        var debtAmount = Number(saleRecord.displayTotalAmount || saleRecord.rawTotalAmount || saleRecord.totalAmount || saleRecord.amount || 0) || 0;
        var operations = Array.isArray(debtOperations) ? debtOperations.slice() : [];
        var paidAmount = 0;
        operations.forEach(function (entry) {
            if (!entry) return;
            var entryType = String(entry.type || '').trim().toLowerCase();
            if (entryType !== 'payment' && entryType !== 'settle') return;
            var allocations = Array.isArray(entry.allocations) ? entry.allocations : [];
            if (allocations.length) {
                allocations.forEach(function (allocation) {
                    if (!allocation) return;
                    var candidateSaleId = normalizeIdValue(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '');
                    if (String(candidateSaleId) === String(saleId)) {
                        paidAmount += Number(allocation.amount) || 0;
                    }
                });
                return;
            }
            var directSaleId = normalizeIdValue(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || '');
            if (String(directSaleId) === String(saleId)) {
                paidAmount += Number(entry.amount) || 0;
            }
        });
        var remainingDebt = Math.max(0, debtAmount - paidAmount);
        var salePercent = debtAmount > 0 ? Number(((paidAmount / debtAmount) * 100).toFixed(2)) : 0;
        var targetDebtOperation = operations.find(function (entry) {
            if (!entry) return false;
            var entryType = String(entry.type || '').trim().toLowerCase();
            if (entryType !== 'debt' && entryType !== 'settle') return false;
            var currentSaleId = normalizeIdValue(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || entry.debtSaleId || entry.objectId || '');
            if (currentSaleId && String(currentSaleId) === String(saleId)) return true;
            var debtOperationId = String(entry.id || entry.debtOperationId || entry.operationId || '');
            var linkedId = String(saleRecord.debtOperationId || saleRecord.linkedDebtOperationId || saleRecord.relatedDebtOperationId || saleRecord.saleDebtOperationId || '');
            return Boolean(linkedId) && String(debtOperationId) === String(linkedId);
        });
        if (targetDebtOperation) {
            targetDebtOperation.amount = debtAmount;
            targetDebtOperation.saleId = saleRecord.saleId || targetDebtOperation.saleId;
            targetDebtOperation.relatedSaleId = saleRecord.saleId || targetDebtOperation.relatedSaleId;
            targetDebtOperation.linkedSaleId = saleRecord.saleId || targetDebtOperation.linkedSaleId;
            targetDebtOperation.customerId = saleRecord.customerId || targetDebtOperation.customerId;
            targetDebtOperation.customerName = saleRecord.customerName || targetDebtOperation.customerName || '';
            targetDebtOperation.status = remainingDebt <= 0 ? 'settled' : 'active';
        }
        var status = remainingDebt <= 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'unpaid');
        return { debtAmount: debtAmount, remainingDebt: remainingDebt, salePercent: salePercent, status: status, operations: operations };
    }

    function getCustomerSalePaymentAllocations(sales, debtOperations) {
        var salesList = Array.isArray(sales) ? sales.filter(function (sale) {
            return sale && isOriginalCreditSale(sale);
        }) : [];
        var paymentEntries = Array.isArray(debtOperations) ? debtOperations.filter(function (entry) {
            return entry && (entry.type === 'payment' || entry.type === 'settle') && String(entry.customerId || '').trim();
        }) : [];
        var groupedSales = {};

        salesList.forEach(function (sale) {
            var customerId = normalizeIdValue(sale.customerId);
            if (!customerId) return;
            if (!groupedSales[customerId]) groupedSales[customerId] = [];
            groupedSales[customerId].push(sale);
        });

        Object.keys(groupedSales).forEach(function (customerId) {
            groupedSales[customerId].sort(function (a, b) {
                return normalizeTimestampValue(a && a.timestamp) - normalizeTimestampValue(b && b.timestamp);
            });
        });

        var customerMap = {};
        Object.keys(groupedSales).forEach(function (customerId) {
            customerMap[customerId] = {};
            var paymentQueue = paymentEntries.filter(function (entry) { return String(entry.customerId) === String(customerId); }).sort(function (a, b) {
                return normalizeTimestampValue(a && a.timestamp) - normalizeTimestampValue(b && b.timestamp);
            });
            var salesForCustomer = groupedSales[customerId];
            var allocation = {};
            salesForCustomer.forEach(function (sale) {
                var saleKey = normalizeIdValue(sale.saleId || sale.id || sale.debtOperationId || sale.relatedSaleId || sale.relatedDebtOperationId || sale.linkedSaleId || sale.linkedDebtOperationId || sale.saleDebtOperationId);
                if (!saleKey) return;
                allocation[saleKey] = 0;
            });
            paymentQueue.forEach(function (payment) {
                var paymentAllocations = Array.isArray(payment.allocations) ? payment.allocations : [];
                if (paymentAllocations.length) {
                    paymentAllocations.forEach(function (allocationEntry) {
                        var targetSaleId = normalizeIdValue(allocationEntry && allocationEntry.saleId);
                        if (!targetSaleId || String(allocationEntry.customerId || payment.customerId || customerId) !== String(customerId)) return;
                        var matchedSale = salesForCustomer.find(function (sale) {
                            var saleKey = normalizeIdValue(sale.saleId || sale.id || sale.debtOperationId || sale.relatedSaleId || sale.relatedDebtOperationId || sale.linkedSaleId || sale.linkedDebtOperationId || sale.saleDebtOperationId);
                            return String(saleKey) === String(targetSaleId);
                        });
                        if (!matchedSale) return;
                        var status = String(allocationEntry.status || 'active').trim().toLowerCase();
                        var baseAmount = Number(allocationEntry.amount) || 0;
                        if (status === 'refunded' || status === 'returned' || status === 'cancelled') return;
                        if (status === 'partially_refunded' || status === 'partially_returned') {
                            baseAmount = Math.max(0, baseAmount - (Number(allocationEntry.refundedAmount || allocationEntry.refundAmount || 0) || 0));
                        }
                        if (baseAmount <= 0) return;
                        var saleKey = targetSaleId;
                        var currentPaid = Number(allocation[saleKey]) || 0;
                        var saleNetAmount = getSaleNetAmount(matchedSale);
                        var cap = Math.max(0, saleNetAmount - currentPaid);
                        if (cap <= 0) return;
                        var applied = Math.min(baseAmount, cap);
                        allocation[saleKey] = currentPaid + applied;
                    });
                    return;
                }

                var remaining = Number(payment.amount) || 0;
                if (remaining <= 0) return;
                salesForCustomer.forEach(function (sale) {
                    if (remaining <= 0) return;
                    var saleKey = normalizeIdValue(sale.saleId || sale.id || sale.debtOperationId || sale.relatedSaleId || sale.relatedDebtOperationId || sale.linkedSaleId || sale.linkedDebtOperationId || sale.saleDebtOperationId);
                    if (!saleKey) return;
                    var saleAmount = getSaleNetAmount(sale);
                    var currentPaid = Number(allocation[saleKey]) || 0;
                    var gap = Math.max(0, saleAmount - currentPaid);
                    if (gap <= 0) return;
                    var applied = Math.min(remaining, gap);
                    allocation[saleKey] = currentPaid + applied;
                    remaining -= applied;
                });
            });
            customerMap[customerId] = allocation;
        });

        return customerMap;
    }

    function getSalePaymentProgress(sale, sales, debtOperations) {
        var saleRecord = sale || {};
        var isCredit = isOriginalCreditSale(saleRecord);
        var amount = getSaleReferenceAmount(saleRecord);
        if (!isCredit || amount <= 0) {
            return {
                amount: amount,
                paidAmount: 0,
                percent: 0,
                isPaid: false,
                isCredit: false,
                hasPayment: false,
                color: '#d83a4b',
                background: '#d83a4b'
            };
        }

        if (isRefundedSale(saleRecord)) {
            return {
                amount: amount,
                paidAmount: 0,
                percent: 0,
                isPaid: false,
                isCredit: true,
                hasPayment: false,
                color: '#d83a4b',
                background: '#d83a4b',
                status: 'refunded'
            };
        }

        var customerId = normalizeIdValue(saleRecord.customerId);
        var saleId = normalizeIdValue(saleRecord.saleId || saleRecord.id || saleRecord.debtOperationId || saleRecord.relatedSaleId || saleRecord.relatedDebtOperationId || saleRecord.linkedSaleId || saleRecord.linkedDebtOperationId || saleRecord.saleDebtOperationId);
        var allocations = getCustomerSalePaymentAllocations(sales, debtOperations);
        var paidAmount = customerId && saleId && allocations[customerId] ? Number(allocations[customerId][saleId]) || 0 : 0;
        var effectiveAmount = getSaleNetAmount(saleRecord);
        var percent = effectiveAmount > 0 ? clampPercent((paidAmount / effectiveAmount) * 100) : 0;
        var isPaid = percent >= 100;
        var hasPayment = paidAmount > 0;
        var color = getPaymentProgressColor(percent);
        return {
            amount: amount,
            paidAmount: paidAmount,
            percent: percent,
            isPaid: isPaid,
            isCredit: true,
            hasPayment: hasPayment,
            color: color,
            background: isPaid ? 'linear-gradient(90deg, #159447 0%, #159447 100%)' : percent <= 0 ? '#d83a4b' : 'linear-gradient(90deg, #d83a4b 0%, ' + color + ' 100%)',
            status: getSaleStatusKey(saleRecord) || 'active'
        };
    }

    function getOperationDisplayDateValue(entry) {
        if (!entry || typeof entry !== 'object') return 0;
        var directDate = entry.operationDate || entry.operation_date || entry.dateKey || entry.date || entry.operationDateKey || '';
        if (typeof directDate === 'string' && directDate.trim()) {
            var trimmed = directDate.trim();
            var isoCandidate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed + 'T12:00:00' : trimmed;
            var parsed = Date.parse(isoCandidate);
            if (Number.isFinite(parsed)) return parsed;
        }
        return normalizeTimestampValue(entry.timestamp) || 0;
    }

    function getCustomerDebtBalance(customerId, sales, debtOperations) {
        var customerSales = Array.isArray(sales) ? sales.filter(function (sale) {
            if (!sale || String(sale.customerId || '') !== String(customerId)) return false;
            if (sale.cancelled || sale.status === 'cancelled' || sale.isCancelled) return false;
            if (isRefundedSale(sale)) return false;
            return isOriginalCreditSale(sale);
        }) : [];
        var allocations = getCustomerSalePaymentAllocations(sales, debtOperations);
        var customerAllocations = allocations[normalizeIdValue(customerId)] || {};
        var totalDebt = customerSales.reduce(function (sum, sale) {
            var saleId = normalizeIdValue(sale.saleId || sale.id || sale.debtOperationId || sale.relatedSaleId || sale.relatedDebtOperationId || sale.linkedSaleId || sale.linkedDebtOperationId || sale.saleDebtOperationId);
            var totalAmount = getSaleNetAmount(sale);
            if (!saleId) return sum + totalAmount;
            return sum + Math.max(0, totalAmount - (Number(customerAllocations[saleId]) || 0));
        }, 0);

        var directEntries = Array.isArray(debtOperations) ? debtOperations.filter(function (entry) {
            if (!entry || String(entry.customerId || '') !== String(customerId)) return false;
            if (entry.status === 'cancelled' || entry.status === 'deleted') return false;
            var type = String(entry.type || '').trim().toLowerCase();
            return type === 'debt' || type === 'payment' || type === 'settle';
        }) : [];

        directEntries.forEach(function (entry) {
            var type = String(entry.type || '').trim().toLowerCase();
            var saleRef = entry.saleId || entry.relatedSaleId || entry.linkedSaleId || entry.debtSaleId || entry.objectId || '';
            var amount = Number(entry.amount) || 0;
            if (type === 'debt' && !saleRef) {
                totalDebt += amount;
            } else if ((type === 'payment' || type === 'settle') && !saleRef && customerSales.length === 0) {
                totalDebt -= amount;
            }
        });

        return totalDebt;
    }

    function getDebtOperationPaymentProgress(entry, paymentEntries) {
        if (!entry || String(entry.type || '').trim().toLowerCase() !== 'debt') {
            return { paidAmount: 0, percent: 0, isPaid: false };
        }
        var debtAmount = Number(entry.amount) || 0;
        if (debtAmount <= 0) {
            return { paidAmount: 0, percent: 0, isPaid: false };
        }
        var debtId = String(entry.id || entry.debtOperationId || entry.operationId || '').trim();
        var saleId = String(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || entry.objectId || entry.debtSaleId || '').trim();
        var payments = Array.isArray(paymentEntries) ? paymentEntries : [];
        var paidAmount = 0;
        payments.forEach(function (payment) {
            if (!payment || (String(payment.type || '').trim().toLowerCase() !== 'payment' && String(payment.type || '').trim().toLowerCase() !== 'settle')) return;
            var allocations = Array.isArray(payment.allocations) ? payment.allocations : [];
            if (allocations.length) {
                allocations.forEach(function (allocation) {
                    if (!allocation) return;
                    var candidateSaleId = String(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '').trim();
                    var candidateDebtId = String(allocation.debtOperationId || allocation.linkedDebtOperationId || allocation.relatedDebtOperationId || '').trim();
                    var matches = Boolean((debtId && candidateDebtId && candidateDebtId === debtId) || (saleId && candidateSaleId === saleId));
                    if (!matches) return;
                    var status = String(allocation.status || payment.status || 'active').trim().toLowerCase();
                    var amount = Number(allocation.amount) || 0;
                    if (status === 'refunded' || status === 'returned' || status === 'cancelled') return;
                    if (status === 'partially_refunded' || status === 'partially_returned') {
                        amount = Math.max(0, amount - (Number(allocation.refundedAmount || allocation.refundAmount || 0) || 0));
                    }
                    paidAmount += amount;
                });
            } else if (saleId && String(payment.saleId || payment.relatedSaleId || payment.linkedSaleId || '') === saleId) {
                paidAmount += Number(payment.amount) || 0;
            }
        });
        var percent = debtAmount > 0 ? Math.min(100, (paidAmount / debtAmount) * 100) : 0;
        return { paidAmount: paidAmount, percent: percent, isPaid: percent >= 100 };
    }

    function reassignPaymentsForCancelledSale(customerId, cancelledSaleId, sales, debtOperations) {
        var targetCustomerId = normalizeIdValue(customerId);
        var targetSaleId = normalizeIdValue(cancelledSaleId);
        if (!targetCustomerId || !targetSaleId) {
            return { reassignedAmount: 0, assignments: [] };
        }

        var activeSales = Array.isArray(sales) ? sales.filter(function (sale) {
            if (!sale || String(sale.customerId || '') !== String(targetCustomerId)) return false;
            if (sale.cancelled || sale.status === 'cancelled' || sale.isCancelled || isRefundedSale(sale)) return false;
            var saleKey = normalizeIdValue(sale.saleId || sale.id || sale.debtOperationId || sale.relatedSaleId || sale.relatedDebtOperationId || sale.linkedSaleId || sale.linkedDebtOperationId || sale.saleDebtOperationId);
            return Boolean(saleKey) && String(saleKey) !== String(targetSaleId);
        }).sort(function (a, b) {
            return normalizeTimestampValue(a && a.timestamp) - normalizeTimestampValue(b && b.timestamp);
        }) : [];

        var reassignedAmount = 0;
        var paymentEntries = Array.isArray(debtOperations) ? debtOperations.filter(function (entry) {
            if (!entry || String(entry.customerId || '') !== String(targetCustomerId)) return false;
            var type = String(entry.type || '').trim().toLowerCase();
            return type === 'payment' || type === 'settle';
        }) : [];

        paymentEntries.forEach(function (entry) {
            var allocations = Array.isArray(entry.allocations) ? entry.allocations : [];
            if (allocations.length) {
                allocations.forEach(function (allocation) {
                    if (!allocation) return;
                    var candidateSaleId = normalizeIdValue(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '');
                    if (String(candidateSaleId) === String(targetSaleId)) {
                        reassignedAmount += Number(allocation.amount) || 0;
                    }
                });
                return;
            }
            var directSaleId = normalizeIdValue(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || '');
            if (String(directSaleId) === String(targetSaleId)) {
                reassignedAmount += Number(entry.amount) || 0;
            }
        });

        var assignments = [];
        var remaining = reassignedAmount;
        activeSales.forEach(function (sale) {
            if (remaining <= 0) return;
            var saleKey = normalizeIdValue(sale.saleId || sale.id || sale.debtOperationId || sale.relatedSaleId || sale.relatedDebtOperationId || sale.linkedSaleId || sale.linkedDebtOperationId || sale.saleDebtOperationId);
            if (!saleKey) return;
            var currentPaid = 0;
            paymentEntries.forEach(function (entry) {
                if (!entry) return;
                var allocations = Array.isArray(entry.allocations) ? entry.allocations : [];
                if (allocations.length) {
                    allocations.forEach(function (allocation) {
                        if (!allocation) return;
                        var candidateSaleId = normalizeIdValue(allocation.saleId || allocation.relatedSaleId || allocation.linkedSaleId || '');
                        if (String(candidateSaleId) === String(saleKey)) {
                            currentPaid += Number(allocation.amount) || 0;
                        }
                    });
                    return;
                }
                var directSaleId = normalizeIdValue(entry.saleId || entry.relatedSaleId || entry.linkedSaleId || '');
                if (String(directSaleId) === String(saleKey)) {
                    currentPaid += Number(entry.amount) || 0;
                }
            });
            var totalAmount = Number(sale.displayTotalAmount || sale.rawTotalAmount || sale.totalAmount || sale.amount || 0) || 0;
            var room = Math.max(0, totalAmount - currentPaid);
            if (room <= 0) return;
            var assignment = Math.min(remaining, room);
            if (assignment > 0) {
                assignments.push({ saleId: saleKey, amount: assignment });
                remaining -= assignment;
            }
        });

        return { reassignedAmount: reassignedAmount, assignments: assignments };
    }

    var helpers = {
        normalizeEmailKey: normalizeEmailKey,
        flattenNameMap: flattenNameMap,
        resolveSellerName: resolveSellerName,
        getArabicInitial: getArabicInitial,
        normalizeIdValue: normalizeIdValue,
        getRecordKey: getRecordKey,
        uniqueRecordsById: uniqueRecordsById,
        convertSecondaryToPrimary: convertSecondaryToPrimary,
        convertPrimaryToSecondary: convertPrimaryToSecondary,
        normalizeSaleForCancellation: normalizeSaleForCancellation,
        getSaleEditQuantityLimit: getSaleEditQuantityLimit,
        findLinkedDebtOperation: findLinkedDebtOperation,
        findSaleByDebtOperation: findSaleByDebtOperation,
        normalizeTimestampValue: normalizeTimestampValue,
        isOriginalCreditSale: isOriginalCreditSale,
        reconcileCreditSaleDebtAfterEdit: reconcileCreditSaleDebtAfterEdit,
        getCustomerSalePaymentAllocations: getCustomerSalePaymentAllocations,
        getSalePaymentProgress: getSalePaymentProgress,
        getSaleReferenceAmount: getSaleReferenceAmount,
        getSaleNetAmount: getSaleNetAmount,
        getSalePaidAmount: getSalePaidAmount,
        getPaymentProgressColor: getPaymentProgressColor,
        getCustomerDebtBalance: getCustomerDebtBalance,
        getDebtOperationPaymentProgress: getDebtOperationPaymentProgress,
        groupDebtOperationsByCycles: groupDebtOperationsByCycles,
        reassignPaymentsForCancelledSale: reassignPaymentsForCancelledSale
    };

    global.XMetalMobileSalesHelpers = helpers;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = helpers;
    }
})(typeof window !== 'undefined' ? window : globalThis);
