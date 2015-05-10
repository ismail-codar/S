(function () {
    // UMD exporter
    if (typeof module === 'object' && typeof module.exports === 'object') module.exports = S; // CommonJS
    else if (typeof define === 'function') define([], function () { return S; }); // AMD
    else this.S = S; // fallback to global object

    // "Globals" used to keep track of current system state
    var NodeCount = 0,
        UpdatingNode = null,
        Freezing = null;

    function S(fn /*, ...args */) {
        // wrap any included args into fn call
        var _fn, _args, i, len;
        if (arguments.length > 1) {
            _fn = fn;
            _args = Array.prototype.slice.call(arguments, 1);
            fn = function () { return _fn.apply(null, _args); };
        }

        var options = this instanceof FormulaOptionsBuilder ? this.options : new FormulaOptions(),
            parent = UpdatingNode,
            region = options.region || (parent && parent.region) || null,
            payload = new Payload(fn),
            node = new Node(++NodeCount, payload, region);

        UpdatingNode = node;

        if (options.sources) {
            i = -1, len = options.sources.length;
            while (++i < len) options.sources[i]();
            payload.listening = false;
        }

        if (parent) {
            if (parent.payload.pinning || options.pin) parent.payload.finalizers.push(dispose);
            else parent.payload.cleanups.push(dispose);
        }

        if (!options.init || options.init(node)) {
            node.active = true;
            try {
                node.payload.value = node.payload.fn();
            } catch (ex) {
                reset(node);
                throw ex;
            } finally {
                node.active = false;
                UpdatingNode = parent;
            }
        } else {
            UpdatingNode = parent;
        }

        formula.dispose = dispose;
        //formula.toString = toString;
        formula.toJSON = signalToJSON;

        return formula;

        function formula() {
            if (!node) return;
            addEdge(node);
            if (node.marks !== 0) backtrack(node);
            return node.payload.value;
        }

        function dispose() {
            if (!node) return;
            var i, len;

            cleanup(payload);

            i = -1, len = payload.finalizers.length;
            while (++i < len) {
                payload.finalizers[i]();
            }

            payload.fn = null;
            payload.value = null;
            payload.finalizers = null;
            payload = null;

            i = -1, len = node.inbound.length;
            while (++i < len) {
                deactivate(node.inbound[i]);
            }

            node.payload = null;
            node.inbound = null;
            node.inboundIndex = null;
            node.outbound = null;
            node = null;
        }

        //function toString() {
        //    return "[formula: " + (value !== undefined ? value + " - " : "") + fn + "]";
        //}
    }

    S.data = function data(value) {
        var node = new Node(++NodeCount, null, UpdatingNode ? UpdatingNode.region : null);

        data.toJSON = signalToJSON;

        return data;

        function data(newValue) {
            var oldNode;
            if (arguments.length > 0) {
                value = newValue;
                if (Freezing) {
                    Freezing(node);
                } else {
                    mark(node);

                    oldNode = UpdatingNode, UpdatingNode = null;
                    try {
                        update(node);
                    } catch (ex) {
                        reset(node);
                        throw ex;
                    } finally {
                        UpdatingNode = oldNode;
                    }
                }
            } else {
                addEdge(node);
            }
            return value;
        }
    }

    /// Options
    function FormulaOptions() {
        this.sources = null;
        this.pin     = false;
        this.init    = null;
        this.region  = null;
    }

    function FormulaOptionsBuilder() {
        this.options = new FormulaOptions();
    }

    FormulaOptionsBuilder.prototype = {
        on: function (/* ...sources */) {
            this.options.sources = Array.prototype.slice.apply(arguments);
            return this;
        },
        once: function () {
            this.options.sources = [];
            return this;
        },
        pin: function () {
            this.options.pin = true;
            return this;
        },
        defer: function () { return this; },
        throttle: function throttle(t) {
            var region = S.region(),
                last = 0,
                scheduled = false;

            this.options.region = function throttle(emitter) {
                var now = Date.now();

                region(emitter);

                if ((now - last) > t) {
                    last = now;
                    region.go();
                } else {
                    setTimeout(function throttled() {
                        last = Date.now();
                        region.go();
                    }, t - (now - last));
                }
            };

            return this;
        },
        debounce: function debounce(t) {
            var region = S.region(),
                last = 0,
                tout = 0;

            this.options.region = function debounce(node) {
                var now = Date.now();

                region(node);

                if (now > last) {
                    last = now;
                    if (tout) clearTimeout(tout);

                    tout = setTimeout(region.go, t);
                }
            };

            return this;
        },
        pause: function (region) {
            this.options.region = region;
            return this;
        },
        when: function when(/* ...preds */) {
            var preds = Array.prototype.slice.apply(arguments);
                len = preds.length;

            this.options.sources = preds;
            this.options.region = this.options.init = function when() {
                var i = -1;
                while (++i < len) {
                    if (preds[i]() === undefined) return false;
                }
                return true;
            }

            return this;
        }
    };

    for (var prop in FormulaOptionsBuilder.prototype) {
        S[prop] = (function (prop) { return function (/*...*/) {
                var options = new FormulaOptionsBuilder();
                return options[prop].apply(options, arguments);
        }; })(prop);
    }

    FormulaOptionsBuilder.prototype.S = S;

    function signalToJSON() {
        return this();
    }

    S.region = function region() {
        var nodes = [],
            nodeIndex = {};

        region.go = go;

        return region;

        function region(node) {
            if (!nodeIndex[node.id]) {
                nodes.push(node);
                nodeIndex[node.id] = node;
            }
        }

        function go() {
            var i, node, oldNode;

            i = -1;
            while (++i < nodes.length) {
                mark(nodes[i]);
            }

            oldNode = UpdatingNode, UpdatingNode = null;

            i = -1;
            try {
                while (++i < nodes.length) {
                    update(nodes[i]);
                }
            } catch (ex) {
                i--;
                while (++i < nodes.length) {
                    reset(nodes[i]);
                }
                throw ex;
            } finally {
                UpdatingNode = oldNode;
            }

            nodes = [];
            nodeIndex = {};
        }
    }

    S.peek = function peek(fn) {
        if (UpdatingNode && UpdatingNode.payload.listening) {
            UpdatingNode.payload.listening = false;

            try {
                return fn();
            } finally {
                UpdatingNode.payload.listening = true;
            }
        } else {
            return fn();
        }
    }

    S.pin = function pin(fn) {
        if (arguments.length === 0) {
            return new FormulaOptionsBuilder().pin();
        } else if (UpdatingNode && !UpdatingNode.payload.pinning) {
            UpdatingNode.payload.pinning = true;

            try {
                return fn();
            } finally {
                UpdatingNode.payload.pinning = false;
            }
        } else {
            return fn();
        }
    }

    S.cleanup = function cleanup(fn) {
        if (UpdatingNode) {
            UpdatingNode.payload.cleanups.push(fn);
        } else {
            throw new Error("S.cleanup() must be called from within an S.formula.  Cannot call it at toplevel.");
        }
    }

    S.finalize = function finalize(fn) {
        if (UpdatingNode) {
            UpdatingNode.payload.finalizers.push(fn);
        } else {
            throw new Error("S.finalize() must be called from within an S.formula.  Cannot call it at toplevel.");
        }
    }

    S.freeze = function freeze(fn) {
        if (Freezing) {
            fn();
        } else {
            var freeze = Freezing = S.region();

            try {
                fn();
            } finally {
                Freezing = null;
            }

            freeze.go();
        }
    }

    /// Dependency Graph
    function Node(id, payload, region) {
        this.id = id;
        this.payload = payload;
        this.region = region;

        this.marks = 0;
        this.active = false;

        this.inbound = [];
        this.inboundIndex = [];
        this.outbound = [];
    }

    function Edge(from, to, boundary) {
        this.from = from;
        this.to = to;
        this.boundary = boundary;

        this.active = true;
        this.damaged = false;
        this.gen = to.payload.gen;

        this.outboundOffset = from.outbound.length;

        from.outbound.push(this);
        to.inbound.push(this);
        to.inboundIndex[from.id] = this;
    }

    function Payload(fn) {
        this.fn = fn;

        this.gen = 1;
        this.value = undefined;

        this.listening = true;
        this.pinning = false;

        this.cleanups = [];
        this.finalizers = [];
    }

    function addEdge(from) {
        var to = UpdatingNode,
            edge = null;

        if (to && to.payload.listening) {
            edge = to.inboundIndex[from.id];
            if (edge) activate(edge);
            else new Edge(from, to, to.region && from.region !== to.region);
        }
    }

    function mark(node) {
        node.active = true;

        var i = -1, len = node.outbound.length, edge, to;
        while (++i < len) {
            edge = node.outbound[i];
            if (edge && !edge.marked && (!edge.boundary || edge.to.region(edge.to))) {
                to = edge.to;

                if (to.active)
                    throw new Error("circular dependency"); // TODO: more helpful reporting

                edge.marked = true;
                to.marks++;

                // if this is the first time node's been marked, then propagate
                if (to.marks === 1) {
                    mark(to);
                }
            }
        }

        node.active = false;
    }

    function update(node) {
        var i, len, edge, to, payload;

        node.active = true;

        if (node.payload) {
            payload = node.payload;

            UpdatingNode = node;

            cleanup(payload);

            payload.gen++;

            payload.value = payload.fn();

            if (payload.listening && node.inbound) {
                i = -1, len = node.inbound.length;
                while (++i < len) {
                    edge = node.inbound[i];
                    if (edge.active && edge.gen < payload.gen) {
                        deactivate(edge);
                    }
                }
            }
        }

        i = -1, len = node.outbound.length;
        while (++i < len) {
            edge = node.outbound[i];
            if (edge && edge.marked) {
                to = edge.to;

                edge.marked = false;
                to.marks--;

                if (to.marks === 0) {
                    update(to);
                }
            }
        }

        node.active = false;
    }

    function backtrack(node) {
        var oldNode = UpdatingNode;

        var i = -1, len = node.inbound.length, edge;
        while (++i < len) {
            edge = node.inbound[i];
            if (edge && edge.marked) {
                if (edge.from.marked) {
                    // keep working backwards through the marked nodes ...
                    backtrack(edge.from);
                } else {
                    // ... until we find clean state, from which to start updating
                    update(edge.from);
                }
            }
        }

        UpdatingNode = oldNode;
    }

    function reset(node) {
        node.active = false;

        var i = -1, len = node.outbound.length, edge, to;
        while (++i < len) {
            edge = node.outbound[i];
            if (edge && edge.damaged) {
                to = edge.to;
                edge.damaged = false;
                to.damage = 0;

                reset(to);
            }
        }
    }

    function cleanup(payload) {
        var i = -1, len = payload.cleanups.length;
        while (++i < len) {
            payload.cleanups[i]();
        }
        payload.cleanups = [];
    }

    function activate(edge) {
        if (!edge.active) {
            edge.active = true;
            from.outbound[edge.outboundOffset] = edge;
            edge.from = from;
        }
        edge.gen = edge.to.payload.gen;
    }

    function deactivate(edge) {
        edge.active = false;
        if (edge.from.outbound) edge.from.outbound[edge.outboundOffset] = null;
        edge.from = null;
    }
})();
