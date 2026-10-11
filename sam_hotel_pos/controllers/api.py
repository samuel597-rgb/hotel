from odoo import http
from odoo.http import request
import json


class SamHotelAPI(http.Controller):

    # ─── CATEGORIES ───
    @http.route('/api/sam/categories', type='json', auth='user', methods=['POST'])
    def get_categories(self):
        cats = request.env['sam.pos.category'].search([])
        return [{
            'id': c.id,
            'name': c.name,
            'department': c.department,
            'sequence': c.sequence,
            'color': c.color,
            'icon': c.icon,
        } for c in cats]

    # ─── PRODUCTS ───
    @http.route('/api/sam/products', type='json', auth='user', methods=['POST'])
    def get_products(self, category_id=None):
        domain = [('is_available', '=', True)]
        if category_id:
            domain.append(('category_id', '=', category_id))
        products = request.env['sam.pos.product'].search(domain)
        return [{
            'id': p.id,
            'name': p.name,
            'categoryId': p.category_id.id,
            'price': p.lst_price,
            'unit': p.unit_label,
        } for p in products]

    # ─── CREATE ORDER ───
    @http.route('/api/sam/orders', type='json', auth='user', methods=['POST'])
    def create_order(self, table=None, guests=1, customer=None,
                     lines=None, payment_method='cash'):
        order = request.env['sam.pos.order'].create({
            'table_number': table,
            'guest_count': guests,
            'customer_name': customer,
            'payment_method': payment_method,
            'line_ids': [(0, 0, {
                'product_id': line['productId'],
                'quantity': line['qty'],
            }) for line in (lines or [])],
        })
        order.action_pay()
        return {
            'id': order.id,
            'name': order.name,
            'total': order.total,
            'state': order.state,
        }

    # ─── LIST ORDERS ───
    @http.route('/api/sam/orders/list', type='json', auth='user', methods=['POST'])
    def list_orders(self, limit=50):
        orders = request.env['sam.pos.order'].search([], limit=limit, order='create_date desc')
        return [{
            'id': o.id,
            'name': o.name,
            'table': o.table_number,
            'guests': o.guest_count,
            'customer': o.customer_name,
            'waiter': o.waiter_id.name,
            'total': o.total,
            'state': o.state,
            'createdAt': o.create_date.isoformat(),
        } for o in orders]
