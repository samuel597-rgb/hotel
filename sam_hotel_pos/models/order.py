from odoo import models, fields, api
from odoo.exceptions import UserError


class SamPosOrder(models.Model):
    _name = 'sam.pos.order'
    _description = "Sam's Hotel POS Order"
    _order = 'create_date desc'
    _rec_name = 'name'

    name = fields.Char(default='New', readonly=True, copy=False)
    state = fields.Selection([
        ('draft', 'Draft'),
        ('paid', 'Paid'),
        ('cancelled', 'Cancelled'),
    ], default='draft', string='Status')

    table_number = fields.Char(string='Table')
    guest_count = fields.Integer(string='Guests', default=1)
    customer_name = fields.Char(string='Customer')
    waiter_id = fields.Many2one(
        'res.users', string='Waiter',
        default=lambda self: self.env.user
    )
    company_id = fields.Many2one(
        'res.company', default=lambda self: self.env.company
    )
    currency_id = fields.Many2one(
        'res.currency', related='company_id.currency_id'
    )

    line_ids = fields.One2many('sam.pos.order.line', 'order_id', string='Items')
    subtotal = fields.Monetary(compute='_compute_totals', store=True,
                                currency_field='currency_id')
    tax_amount = fields.Monetary(compute='_compute_totals', store=True,
                                  currency_field='currency_id')
    total = fields.Monetary(compute='_compute_totals', store=True,
                             currency_field='currency_id')

    payment_method = fields.Selection([
        ('cash', 'Cash'),
        ('card', 'Bank Card'),
        ('mpesa', 'M-Pesa'),
    ], default='cash')

    @api.depends('line_ids.subtotal', 'line_ids.tax_amount')
    def _compute_totals(self):
        for order in self:
            order.subtotal = sum(order.line_ids.mapped('subtotal'))
            order.tax_amount = sum(order.line_ids.mapped('tax_amount'))
            order.total = order.subtotal + order.tax_amount

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('sam.pos.order') or 'New'
        return super().create(vals_list)

    def action_pay(self):
        for order in self:
            if order.state != 'draft':
                raise UserError("Only draft orders can be paid.")
            order.state = 'paid'
        return True

    def action_cancel(self):
        self.write({'state': 'cancelled'})


class SamPosOrderLine(models.Model):
    _name = 'sam.pos.order.line'
    _description = "Sam's Hotel POS Order Line"

    order_id = fields.Many2one('sam.pos.order', required=True, ondelete='cascade')
    product_id = fields.Many2one('sam.pos.product', required=True)
    category_id = fields.Many2one(related='product_id.category_id', store=True)

    quantity = fields.Float(default=1.0, required=True)
    unit_price = fields.Monetary(
        related='product_id.lst_price', store=True,
        currency_field='currency_id'
    )
    tax_rate = fields.Float(string='Tax %', default=0.0)
    currency_id = fields.Many2one(related='order_id.currency_id')

    subtotal = fields.Monetary(compute='_compute_amounts', store=True,
                                currency_field='currency_id')
    tax_amount = fields.Monetary(compute='_compute_amounts', store=True,
                                  currency_field='currency_id')
    total = fields.Monetary(compute='_compute_amounts', store=True,
                             currency_field='currency_id')

    @api.depends('quantity', 'unit_price', 'tax_rate')
    def _compute_amounts(self):
        for line in self:
            line.subtotal = line.quantity * line.unit_price
            line.tax_amount = line.subtotal * (line.tax_rate / 100.0)
            line.total = line.subtotal + line.tax_amount
